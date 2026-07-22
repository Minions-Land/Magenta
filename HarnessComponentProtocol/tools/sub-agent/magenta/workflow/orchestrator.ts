/**
 * Workflow orchestrator over sessionless, one-shot workers.
 *
 * Every pattern is executable JavaScript control flow. The six named presets
 * ship fixed runtime-owned order, concurrency, termination, and soul steps; the
 * caller fills only their WorkerSlot content. A script workflow instead gives
 * its author control of if/while/await flow and termination while all worker
 * creation still passes through runtime-owned primitives and safety guards.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	appendBoundedFileSync,
	cleanupLogTree,
	DEFAULT_LOG_MAX_AGE_MS,
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_MAX_TOTAL_BYTES,
} from "../../../../_magenta/log-retention.ts";
import { nodeTimeoutSecondsToMs } from "../../../../_magenta/timeout.ts";
import type {
	CommonOptions,
	MultiAgentDiscoverResult,
	OrchestrationRequest,
	OrchestrationResult,
	Pattern,
	ScriptWorkflowRequest,
	WorkerResult,
	WorkflowContext,
	WorkflowModule,
} from "../workflow-types.ts";
import { aggregateWorkerUsage } from "../workflow-types.ts";
import {
	parallel,
	parallelAgents,
	pipeline,
	type SpawnWorkerOptions,
	spawnWorker,
	type WorkerInvocationResolver,
} from "./worker.ts";

/**
 * The two primitives every pattern needs to run workers. Abstracted so the
 * deterministic control flow can be unit-tested with a fake runner — no real pi
 * processes, no tokens, no risk. The default runner spawns real headless pi.
 */
export type WorkerRunner = {
	spawn(options: SpawnWorkerOptions, signal?: AbortSignal): Promise<WorkerResult>;
	parallel(specs: SpawnWorkerOptions[], maxConcurrent: number, signal?: AbortSignal): Promise<WorkerResult[]>;
};

function createDefaultRunner(resolveInvocation?: WorkerInvocationResolver): WorkerRunner {
	return {
		spawn: (options, signal) => spawnWorker(options, signal, resolveInvocation),
		parallel: (specs, maxConcurrent, signal) => parallel(specs, maxConcurrent, signal, resolveInvocation),
	};
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_WORKFLOW_MAX_FILES = 2_000;
export const WORKFLOW_STATE_ROOT_ENV = "MAGENTA_WORKFLOW_STATE_ROOT";
export const TARGET = "multiagent://local";
const ACTIVE_WORKFLOW_DIRS = new Set<string>();

export type WorkflowRetentionOptions = {
	maxAgeMs?: number;
	maxTotalBytes?: number;
	maxFiles?: number;
	now?: number;
	protectedPrefixes?: Iterable<string>;
};

export const PATTERNS: Pattern[] = [
	"classify_and_act",
	"fan_out_synthesize",
	"adversarial_verify",
	"generate_and_filter",
	"tournament",
	"loop_until_done",
	"script",
];

/**
 * Guard prompts hard-code each pattern's soul step. They are prepended to the
 * relevant worker's system prompt so the LLM cannot skip or dilute the step.
 */
const GUARDS = {
	generator:
		"You are the Generator. Produce the work; do not grade or approve your own " +
		"output. Casting a wide net is better than prematurely narrowing. Grading is " +
		"an independent step performed by someone else.",
	classifier:
		"First determine the type of the input, then handle it according to its type. " +
		"Do not process the input generically without classifying it first. " +
		"Return only the classification label.",
	synthesizer:
		"The following are results from every worker. Merge them into a single " +
		"consolidated artifact. Do not omit any input.",
	verifier:
		"You are an independent verifier. Re-check each reported candidate on its own " +
		"evidence. Prefer missing a real issue over confirming a false one. Return a " +
		"strict boolean verdict per candidate.",
	evaluator:
		"Score the candidate against the stated criteria and return a numeric score. " +
		"Base the score only on the criteria, not on presentation length.",
	judge:
		"You are comparing exactly two candidates. Decide which one is better on the " +
		"stated qualities and return the winner's index (0 or 1) with a brief reason.",
	refine:
		"Findings already discovered in previous rounds are listed below; exclude them. " +
		"Report only NEW findings this round. If there are no new findings, return an " +
		"empty result — do not claim completion on your own judgement.",
} as const;

let workerCounter = 0;
function nextWorkerId(prefix: string): string {
	workerCounter += 1;
	return `${prefix}_${String(workerCounter).padStart(3, "0")}`;
}

// --- Pattern 7: Script Workflow (write the loop, not the prompt) -----------

/** Generate a workflow run id, also used as the .magenta/tmp/<id> dir name. */
function nextWorkflowId(): string {
	return `wf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the state directory for a workflow run: `<cwd>/.magenta/tmp/<id>`.
 * This reuses the harness's established scratch location (the sandbox policy
 * already whitelists `./.magenta/tmp` for writes), rather than inventing a new
 * home-directory path that the process sandbox would reject.
 */
function workflowStateRoot(cwd: string, configuredRoot?: string): string {
	const environmentRoot = process.env[WORKFLOW_STATE_ROOT_ENV]?.trim();
	return path.resolve(configuredRoot || environmentRoot || path.join(cwd, ".magenta", "tmp"));
}

function isRegularFile(filePath: string): boolean {
	try {
		const info = fs.lstatSync(filePath);
		return info.isFile() && !info.isSymbolicLink();
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Remove bounded, completed workflow artifacts while preserving unknown files and live runs. */
export async function cleanupWorkflowArtifacts(
	stateRoot: string,
	options: WorkflowRetentionOptions = {},
): Promise<void> {
	const root = path.resolve(stateRoot);
	const completedRuns = new Set<string>();
	const protectedPrefixes = new Set(
		[...(options.protectedPrefixes ?? [])].map((candidate) => path.resolve(candidate)),
	);
	for (const active of ACTIVE_WORKFLOW_DIRS) protectedPrefixes.add(active);

	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("wf-")) continue;
			const runRoot = path.resolve(root, entry.name);
			const completed =
				isRegularFile(path.join(runRoot, "result.json")) || isRegularFile(path.join(runRoot, "error.json"));
			if (completed) {
				completedRuns.add(runRoot);
			}
			const pidMatch = /^wf-(\d+)-\d+-/.exec(entry.name);
			if (!completed && pidMatch && isProcessAlive(Number(pidMatch[1]))) protectedPrefixes.add(runRoot);
		}
	} catch {
		return;
	}

	const completedParts = (candidate: string): string[] | undefined => {
		const relativePath = path.relative(root, path.resolve(candidate));
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) return undefined;
		const parts = relativePath.split(path.sep);
		if (!completedRuns.has(path.join(root, parts[0]!))) return undefined;
		return parts;
	};

	await cleanupLogTree({
		root,
		fileFilter: (candidate) => {
			const parts = completedParts(candidate);
			if (!parts) return false;
			if (parts.length === 2) return ["log.jsonl", "result.json", "error.json"].includes(parts[1]!);
			return parts.length === 4 && parts[1] === "nodes" && parts[3] === "output.json";
		},
		protectedPrefixes,
		emptyDirectoryFilter: (candidate) => {
			const parts = completedParts(candidate);
			if (!parts) return false;
			return (
				parts.length === 1 ||
				(parts.length === 2 && parts[1] === "nodes") ||
				(parts.length === 3 && parts[1] === "nodes")
			);
		},
		maxAgeMs: options.maxAgeMs ?? DEFAULT_LOG_MAX_AGE_MS,
		maxTotalBytes: options.maxTotalBytes ?? DEFAULT_LOG_MAX_TOTAL_BYTES,
		maxFiles: options.maxFiles ?? DEFAULT_WORKFLOW_MAX_FILES,
		now: options.now,
	});
}

/** Best-effort bounded JSON write; never throws (observability must not break a run). */
function safeWrite(filePath: string, content: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const originalBytes = Buffer.byteLength(content, "utf8");
		const bounded =
			originalBytes <= DEFAULT_LOG_MAX_BYTES
				? content
				: JSON.stringify(
						{
							schemaVersion: 1,
							truncated: true,
							originalBytes,
							message: `Workflow artifact exceeded ${DEFAULT_LOG_MAX_BYTES} bytes and was omitted`,
						},
						null,
						2,
					);
		fs.writeFileSync(filePath, bounded, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Observability is best-effort; a failed write must not abort the workflow.
	}
}

/** Best-effort append; never throws. */
function safeAppend(filePath: string, line: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
		appendBoundedFileSync(filePath, line, DEFAULT_LOG_MAX_BYTES);
	} catch {
		// Best-effort.
	}
}

/**
 * Build the WorkflowContext injected into a script. Every primitive routes
 * through the orchestrator's `runner`, so a script cannot bypass the depth
 * guard, tool denial, timeout, or guard injection. The script controls flow
 * (if/while/await); the runtime controls safety.
 *
 * Observability side effect: phase/log/agent all append to a per-run state
 * directory `<cwd>/.magenta/tmp/<workflowId>/` so a run is inspectable and
 * survives a crash — log.jsonl for the event stream, nodes/<label>/output.json
 * for each agent's structured result.
 */
function buildWorkflowContext(
	runner: WorkerRunner,
	workflowId: string,
	cwd: string,
	stateDir: string,
	spawned: WorkerResult[],
	defaults: Pick<CommonOptions, "model" | "tools" | "packages">,
	signal?: AbortSignal,
): WorkflowContext {
	const logPath = path.join(stateDir, "log.jsonl");
	const event = (type: string, data: Record<string, unknown>) =>
		safeAppend(logPath, `${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);

	const agent: WorkflowContext["agent"] = async (prompt, options) => {
		// Assemble system prompt: guard first (soul step), then schema instruction.
		let systemPrompt: string | undefined;
		const parts: string[] = [];
		if (options?.guard?.trim()) parts.push(options.guard.trim());
		if (options?.schema) {
			parts.push(
				`Return your final answer as JSON matching this schema:\n${JSON.stringify(options.schema, null, 2)}`,
			);
		}
		if (parts.length > 0) systemPrompt = parts.join("\n\n");

		const label = options?.label || nextWorkerId("script");
		const result = await runner.spawn(
			{
				workerId: label,
				prompt,
				systemPrompt,
				model: options?.model ?? defaults.model,
				provider: options?.provider,
				thinking: options?.thinking,
				tools: options?.tools ?? defaults.tools,
				packages: options?.packages ?? defaults.packages,
				schema: options?.schema,
				cwd,
				timeoutMs: nodeTimeoutSecondsToMs(options?.timeoutSeconds, `workflow agent ${label} timeoutSeconds`),
			},
			signal,
		);
		spawned.push(result);
		// Persist this agent's output for inspection / crash recovery.
		safeWrite(path.join(stateDir, "nodes", label, "output.json"), JSON.stringify(result, null, 2));
		event("agent", { label, success: result.success, tokensUsed: result.tokensUsed });
		return result;
	};

	return {
		agent,
		parallelAgents: (tasks, maxConcurrent = DEFAULT_MAX_CONCURRENT) => parallelAgents(tasks, maxConcurrent, signal),
		pipeline: (items, fn, maxConcurrent = DEFAULT_MAX_CONCURRENT) => pipeline(items, fn, maxConcurrent, signal),
		phase: (name: string) => {
			console.log(`\n======== [${workflowId}] ${name} ========\n`);
			event("phase", { name });
		},
		log: (message: string) => {
			console.log(`[${workflowId}] ${message}`);
			event("log", { message });
		},
		guards: { ...GUARDS },
		workflowId,
		cwd,
		signal,
	};
}

/**
 * Run a workflow authored as an executable TS/JS module. Dynamically imports
 * the module, injects the context, and runs its default export. The script's
 * own control flow (if/while/await) drives the orchestration; every spawn is
 * recorded so the OrchestrationResult still lists every worker that ran. The
 * final return value is persisted to `.magenta/tmp/<id>/result.json`.
 */
/**
 * Shared workflow module runner. Dynamically imports a .ts/.js module, injects
 * WorkflowContext, executes its default export, and collects all spawned workers.
 * Returns the raw script result + the spawned array. The caller (preset dispatcher
 * or script runner) assembles the final OrchestrationResult.
 */
async function runWorkflowModule(
	scriptPath: string,
	args: unknown,
	runner: WorkerRunner,
	cwd: string,
	stateRoot: string,
	defaults: Pick<CommonOptions, "model" | "tools" | "packages">,
	retention: WorkflowRetentionOptions,
	signal?: AbortSignal,
): Promise<{ workflowId: string; spawned: WorkerResult[]; returned: unknown; success: boolean; error?: string }> {
	const workflowId = nextWorkflowId();
	const stateDir = path.join(stateRoot, workflowId);
	ACTIVE_WORKFLOW_DIRS.add(stateDir);
	const spawned: WorkerResult[] = [];
	try {
		await cleanupWorkflowArtifacts(stateRoot, retention).catch(() => undefined);
		const context = buildWorkflowContext(runner, workflowId, cwd, stateDir, spawned, defaults, signal);
		try {
			const mod = (await import(scriptPath)) as WorkflowModule;
			if (typeof mod.default !== "function") {
				throw new Error(`workflow module ${scriptPath} has no default export function`);
			}
			const returned = await mod.default(args, context);
			safeWrite(path.join(stateDir, "result.json"), JSON.stringify(returned, null, 2));
			return { workflowId, spawned, returned, success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			safeWrite(path.join(stateDir, "error.json"), JSON.stringify({ error: message }, null, 2));
			return { workflowId, spawned, returned: null, success: false, error: message };
		}
	} finally {
		ACTIVE_WORKFLOW_DIRS.delete(stateDir);
	}
}

/**
 * Assemble an OrchestrationResult from a workflow module's output. Inspects the
 * return value shape (not who authored the script): if it carries known
 * semantic fields (outcome, confidence, finalists, iterations, terminatedBy),
 * preserve them; otherwise treat the return as opaque and wrap it as outcome.
 * This is the single result-assembly path for presets and user scripts alike.
 */
function assembleResult(
	pattern: Pattern,
	result: { workflowId: string; spawned: WorkerResult[]; returned: unknown; success: boolean; error?: string },
): OrchestrationResult {
	if (!result.success) {
		const outcome: WorkerResult = {
			workerId: result.workflowId,
			text: "",
			durationMs: 0,
			success: false,
			error: result.error,
		};
		return {
			pattern,
			workers: [...result.spawned, outcome],
			outcome,
			terminatedBy: "budget",
			usage: aggregateWorkerUsage([...result.spawned, outcome]),
		};
	}

	const ret = result.returned;
	// Structured envelope: the return object carries known semantic fields.
	if (ret && typeof ret === "object" && !Array.isArray(ret)) {
		const envelope = ret as {
			outcome?: WorkerResult;
			confidence?: number;
			finalists?: WorkerResult[];
			iterations?: number;
			terminatedBy?: OrchestrationResult["terminatedBy"];
		};
		const hasSemanticFields =
			"outcome" in envelope ||
			"confidence" in envelope ||
			"finalists" in envelope ||
			"iterations" in envelope ||
			"terminatedBy" in envelope;
		if (hasSemanticFields) {
			const outcome = envelope.outcome ?? result.spawned[result.spawned.length - 1];
			return {
				pattern,
				workers: result.spawned,
				outcome,
				...(envelope.confidence !== undefined ? { confidence: envelope.confidence } : {}),
				...(envelope.finalists ? { finalists: envelope.finalists } : {}),
				...(envelope.iterations !== undefined ? { iterations: envelope.iterations } : {}),
				terminatedBy: envelope.terminatedBy ?? "completed",
				usage: aggregateWorkerUsage(result.spawned),
			};
		}
	}

	// Opaque return: wrap it as the outcome.
	const outcome: WorkerResult = {
		workerId: result.workflowId,
		text: typeof ret === "string" ? ret : JSON.stringify(ret),
		structured: typeof ret === "string" ? undefined : ret,
		durationMs: 0,
		success: true,
	};
	return {
		pattern,
		workers: [...result.spawned, outcome],
		outcome,
		terminatedBy: "completed",
		usage: aggregateWorkerUsage(result.spawned),
	};
}

// --- Script resolution -----------------------------------------------------

/**
 * The six built-in patterns are just preset workflow scripts, authored with the
 * exact same (args, ctx) => {} shape a user script uses. Choosing a preset and
 * writing your own workflow are the same action: load a module and run it. The
 * only difference is where the module comes from — an in-tree preset or a
 * user-supplied path.
 */
const PRESET_SCRIPTS: Record<Exclude<Pattern, "script">, string> = {
	fan_out_synthesize: "./presets/fan-out-synthesize.js",
	classify_and_act: "./presets/classify-and-act.js",
	adversarial_verify: "./presets/adversarial-verify.js",
	generate_and_filter: "./presets/generate-and-filter.js",
	tournament: "./presets/tournament.js",
	loop_until_done: "./presets/loop-until-done.js",
};

/** Resolve a request to the workflow module path it should load. */
function resolveScriptPath(req: OrchestrationRequest): string {
	if (req.pattern === "script") {
		return (req as ScriptWorkflowRequest).scriptPath;
	}
	return new URL(PRESET_SCRIPTS[req.pattern], import.meta.url).href;
}

export class MultiAgentOrchestrator {
	private readonly defaultCwd: string;
	private readonly runner: WorkerRunner;
	private readonly stateRoot?: string;
	private readonly retention: WorkflowRetentionOptions;

	constructor(
		options: {
			cwd?: string;
			runner?: WorkerRunner;
			resolveWorkerInvocation?: WorkerInvocationResolver;
			stateRoot?: string;
			retention?: WorkflowRetentionOptions;
		} = {},
	) {
		this.defaultCwd = options.cwd ?? process.cwd();
		this.stateRoot = options.stateRoot;
		this.retention = options.retention ?? {};
		// Injectable so deterministic skeletons can be tested without spawning pi.
		this.runner = options.runner ?? createDefaultRunner(options.resolveWorkerInvocation);
	}

	discover(): MultiAgentDiscoverResult {
		return { provider: "multiagent", targets: [TARGET], patterns: PATTERNS };
	}

	async orchestrate(request: OrchestrationRequest, signal?: AbortSignal): Promise<OrchestrationResult> {
		const req = { cwd: this.defaultCwd, ...request } as OrchestrationRequest;
		// One path for everything: resolve which module to load (a built-in preset
		// or a user-supplied script), run it, assemble the result from its return.
		const scriptPath = resolveScriptPath(req);
		const args = req.pattern === "script" ? (req as ScriptWorkflowRequest).args : req;
		const cwd = (req as CommonOptions).cwd ?? this.defaultCwd;
		const stateRoot = workflowStateRoot(cwd, this.stateRoot);
		const result = await runWorkflowModule(
			scriptPath,
			args,
			this.runner,
			cwd,
			stateRoot,
			req,
			this.retention,
			signal,
		);
		return assembleResult(req.pattern, result);
	}
}
