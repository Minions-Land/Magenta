/**
 * Orchestrator: the deterministic control-flow skeletons for each pattern.
 *
 * Every pattern here is plain JavaScript control flow — `for`, `await`, `if`.
 * That is the guarantee: the shape, the termination, and each pattern's soul
 * step are code, not prompts. The LLM fills `WorkerSlot` content; it never
 * decides the order, the concurrency, or when to stop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HcpServer } from "../../../../hcp-contract/hcp-server.ts";
import type {
	AdversarialVerifyRequest,
	ClassifyAndActRequest,
	CommonOptions,
	FanOutSynthesizeRequest,
	GenerateAndFilterRequest,
	LoopUntilDoneRequest,
	MultiAgentDiscoverResult,
	MultiAgentProviderContract,
	OrchestrationRequest,
	OrchestrationResult,
	Pattern,
	ScriptWorkflowRequest,
	TournamentRequest,
	WorkerResult,
	WorkerSlot,
	WorkflowContext,
	WorkflowModule,
} from "../../contract.ts";
import { buildSystemPrompt, parallel, type SpawnWorkerOptions, spawnWorker } from "./worker.ts";

/**
 * The two primitives every pattern needs to run workers. Abstracted so the
 * deterministic control flow can be unit-tested with a fake runner — no real pi
 * processes, no tokens, no risk. The default runner spawns real headless pi.
 */
export interface WorkerRunner {
	spawn(options: SpawnWorkerOptions, signal?: AbortSignal): Promise<WorkerResult>;
	parallel(specs: SpawnWorkerOptions[], maxConcurrent: number, signal?: AbortSignal): Promise<WorkerResult[]>;
}

const defaultRunner: WorkerRunner = { spawn: spawnWorker, parallel };

const DEFAULT_MAX_CONCURRENT = 8;
const TARGET = "multiagent://local";

const PATTERNS: Pattern[] = [
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
	return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the state directory for a workflow run: `<cwd>/.magenta/tmp/<id>`.
 * This reuses the harness's established scratch location (the sandbox policy
 * already whitelists `./.magenta/tmp` for writes), rather than inventing a new
 * home-directory path that the process sandbox would reject.
 */
function workflowStateDir(cwd: string, workflowId: string): string {
	return path.join(cwd, ".magenta", "tmp", workflowId);
}

/** Best-effort mkdir + write; never throws (observability must not break a run). */
function safeWrite(filePath: string, content: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content, "utf8");
	} catch {
		// Observability is best-effort; a failed write must not abort the workflow.
	}
}

/** Best-effort append; never throws. */
function safeAppend(filePath: string, line: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, line, "utf8");
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
	spawned: WorkerResult[],
	signal?: AbortSignal,
): WorkflowContext {
	const stateDir = workflowStateDir(cwd, workflowId);
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
				model: options?.model,
				provider: options?.provider,
				thinking: options?.thinking,
				tools: options?.tools,
				schema: options?.schema,
				cwd,
				timeoutMs: options?.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : undefined,
			},
			signal,
		);
		spawned.push(result);
		// Persist this agent's output for inspection / crash recovery.
		safeWrite(path.join(stateDir, "nodes", label, "output.json"), JSON.stringify(result, null, 2));
		event("agent", { label, success: result.success, tokensUsed: result.tokensUsed });
		return result;
	};

	const parallelAgents: WorkflowContext["parallelAgents"] = async (tasks, maxConcurrent = DEFAULT_MAX_CONCURRENT) => {
		const limit = Math.max(1, maxConcurrent);
		const results = new Array(tasks.length);
		let next = 0;
		async function lane(): Promise<void> {
			while (true) {
				const i = next++;
				if (i >= tasks.length) return;
				results[i] = await tasks[i]();
			}
		}
		await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => lane()));
		return results;
	};

	const pipeline: WorkflowContext["pipeline"] = async (items, fn, maxConcurrent = DEFAULT_MAX_CONCURRENT) => {
		const results: unknown[] = [];
		const limit = Math.max(1, maxConcurrent);
		let next = 0;
		async function lane(): Promise<void> {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results.push(await fn(items[i], i));
			}
		}
		await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
		return results as never;
	};

	return {
		agent,
		parallelAgents,
		pipeline,
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
	signal?: AbortSignal,
): Promise<{ workflowId: string; spawned: WorkerResult[]; returned: unknown; success: boolean; error?: string }> {
	const workflowId = nextWorkflowId();
	const spawned: WorkerResult[] = [];
	const context = buildWorkflowContext(runner, workflowId, cwd, spawned, signal);
	const stateDir = workflowStateDir(cwd, workflowId);

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
}

async function runScript(
	req: ScriptWorkflowRequest,
	runner: WorkerRunner,
	defaultCwd: string,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const result = await runWorkflowModule(req.scriptPath, req.args, runner, req.cwd ?? defaultCwd, signal);

	// For user scripts, the return value is opaque; wrap it as outcome.
	const outcome: WorkerResult = result.success
		? {
				workerId: result.workflowId,
				text: typeof result.returned === "string" ? result.returned : JSON.stringify(result.returned),
				structured: typeof result.returned === "string" ? undefined : result.returned,
				durationMs: 0,
				success: true,
		  }
		: {
				workerId: result.workflowId,
				text: "",
				durationMs: 0,
				success: false,
				error: result.error,
		  };

	return {
		pattern: "script",
		workers: [...result.spawned, outcome],
		outcome,
		terminatedBy: outcome.success ? "completed" : "budget",
	};
}

/** The magenta multi-agent orchestration provider. */
// --- Preset dispatch -------------------------------------------------------

/**
 * The six built-in patterns are just preset workflow scripts, authored with the
 * exact same (args, ctx) => {} shape a user script uses and executed through the
 * same runWorkflowModule path. The only difference: a preset returns a small
 * structured envelope ({ outcome?, confidence?, finalists?, iterations?,
 * terminatedBy? }) so the dispatcher can preserve each pattern's semantic fields
 * in the OrchestrationResult. A user script's return value stays opaque.
 */
const PRESET_SCRIPTS: Record<Exclude<Pattern, "script">, string> = {
	fan_out_synthesize: "./presets/fan-out-synthesize.js",
	classify_and_act: "./presets/classify-and-act.js",
	adversarial_verify: "./presets/adversarial-verify.js",
	generate_and_filter: "./presets/generate-and-filter.js",
	tournament: "./presets/tournament.js",
	loop_until_done: "./presets/loop-until-done.js",
};

async function runPreset(
	pattern: Exclude<Pattern, "script">,
	req: OrchestrationRequest,
	runner: WorkerRunner,
	defaultCwd: string,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const scriptPath = new URL(PRESET_SCRIPTS[pattern], import.meta.url).href;
	const result = await runWorkflowModule(scriptPath, req, runner, (req as CommonOptions).cwd ?? defaultCwd, signal);

	if (!result.success) {
		const outcome: WorkerResult = {
			workerId: result.workflowId,
			text: "",
			durationMs: 0,
			success: false,
			error: result.error,
		};
		return { pattern, workers: [...result.spawned, outcome], outcome, terminatedBy: "budget" };
	}

	// Preset envelope: pull semantic fields, default outcome to the last spawned worker.
	const envelope = (result.returned ?? {}) as {
		outcome?: WorkerResult;
		confidence?: number;
		finalists?: WorkerResult[];
		iterations?: number;
		terminatedBy?: OrchestrationResult["terminatedBy"];
	};
	const outcome = envelope.outcome ?? result.spawned[result.spawned.length - 1];

	return {
		pattern,
		workers: result.spawned,
		outcome,
		...(envelope.confidence !== undefined ? { confidence: envelope.confidence } : {}),
		...(envelope.finalists ? { finalists: envelope.finalists } : {}),
		...(envelope.iterations !== undefined ? { iterations: envelope.iterations } : {}),
		terminatedBy: envelope.terminatedBy ?? "completed",
	};
}

export class MultiAgentOrchestrator implements MultiAgentProviderContract {
	private readonly defaultCwd: string;
	private readonly runner: WorkerRunner;

	constructor(options: { cwd?: string; runner?: WorkerRunner } = {}) {
		this.defaultCwd = options.cwd ?? process.cwd();
		// Injectable so deterministic skeletons can be tested without spawning pi.
		this.runner = options.runner ?? defaultRunner;
	}

	discover(): MultiAgentDiscoverResult {
		return { provider: "multiagent", targets: [TARGET], patterns: PATTERNS };
	}

	async orchestrate(request: OrchestrationRequest, signal?: AbortSignal): Promise<OrchestrationResult> {
		const req = { cwd: this.defaultCwd, ...request } as OrchestrationRequest;
		const runner = this.runner;
		if (req.pattern === "script") {
			return runScript(req as ScriptWorkflowRequest, runner, this.defaultCwd, signal);
		}
		return runPreset(req.pattern, req, runner, this.defaultCwd, signal);
	}

	toHcpServer(): HcpServer {
		const provider = this;
		return {
			describe() {
				return {
					target: TARGET,
					kind: "multiagent",
					ops: ["discover", "orchestrate"],
					description: "Deterministic multi-agent orchestration workflows.",
					metadata: { patterns: PATTERNS },
				};
			},
			async call(request: import("../../../../hcp-contract/hcp-server.ts").HcpRequest) {
				switch (request.op) {
					case "discover":
						return provider.discover();
					case "orchestrate":
						return provider.orchestrate(request.input as OrchestrationRequest);
					default:
						throw new Error(`Unsupported op: ${request.op}`);
				}
			},
			instance<T>(): T {
				return provider as unknown as T;
			},
		};
	}
}
