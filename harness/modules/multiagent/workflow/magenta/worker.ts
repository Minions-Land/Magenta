/**
 * Worker base: the single primitive every orchestration pattern builds on.
 *
 * A "worker" is one headless `pi` process. It is one-shot and process-isolated:
 * it runs, returns a structured result, and exits. Workers do not talk to each
 * other — the orchestrator is the only channel between them. This mirrors pi's
 * proven sub_agent spawn mechanism (structured `--mode json` output, process
 * groups, `--no-extensions` to prevent recursive spawning) without depending on
 * pi's internal SubAgentController.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Isolation, WorkerResult, WorkerSlot, WorkerUsage } from "../../HcpServer.ts";

/** Default tools handed to a worker when none are specified: read-only. */
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Tools a worker may NEVER receive, enforced by stripping them from the `--tools`
 * whitelist regardless of what the caller requests.
 *
 * Orchestration and background delegation are privileges of the MAIN agent only.
 * A worker (a sub-agent or a workflow agent) must not be able to spawn further
 * sub-agents, background shells, or nested orchestrations. This is capability
 * denial at the grant layer: because pi resolves `--tools` into a hard allow-list
 * (`isAllowedTool`), a tool absent from the whitelist is simply not present in
 * the worker's registry — even pi's built-in `sub_agent`/`bg_shell`. This is the
 * primary, structural fork-bomb prevention; the depth guard below is a
 * defense-in-depth backstop.
 */
const FORBIDDEN_WORKER_TOOLS = new Set(["sub_agent", "bg_shell"]);

/**
 * Sanitize a tool whitelist for a worker: drop any forbidden tool. If the result
 * is empty (caller asked only for forbidden tools), fall back to read-only.
 */
export function sanitizeWorkerTools(requested: string[] | undefined): string[] {
	const base = requested && requested.length > 0 ? requested : DEFAULT_TOOLS;
	const allowed = base.filter((name) => !FORBIDDEN_WORKER_TOOLS.has(name));
	return allowed.length > 0 ? allowed : DEFAULT_TOOLS;
}

/** Grace period between SIGTERM and SIGKILL when cancelling a worker. */
const TERM_GRACE_MS = 5000;

/** Hard wall-clock cap per worker. A worker that never finishes is killed. */
const DEFAULT_WORKER_TIMEOUT_MS = 120_000;

/**
 * Recursion guard. Every worker is spawned with PI_MAORCH_DEPTH set one higher
 * than the current process. If we are already inside an orchestrated worker, we
 * refuse to spawn again — orchestration is strictly one level deep. This makes a
 * fork bomb structurally impossible even if pi invocation resolution ever
 * regresses.
 */
const DEPTH_ENV = "PI_MAORCH_DEPTH";
const MAX_DEPTH = 1;

/** Current orchestration depth of this process (0 at the top level). */
export function currentDepth(): number {
	const raw = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Options for a single worker spawn. */
export interface SpawnWorkerOptions {
	/** Task prompt handed to the worker (already assembled from the slot + guard). */
	prompt: string;
	/** Optional system prompt appended to the worker (guard + focus live here). */
	systemPrompt?: string;
	/** Model override. */
	model?: string;
	/** Provider override (optional). */
	provider?: string;
	/** Thinking level for the worker (optional). */
	thinking?: ThinkingLevel;
	/** Tool whitelist. Defaults to read-only tools. */
	tools?: string[];
	/** JSON Schema; when set, the worker's final text is parsed into `structured`. */
	schema?: unknown;
	/** Working directory. */
	cwd?: string;
	/** Isolation level. Only "process" is honored; any other value is refused at spawn time. "worktree" is a future addition. */
	isolation?: Isolation;
	/** Stable id for this worker (for result correlation). */
	workerId: string;
	/** Hard wall-clock timeout in ms. Defaults to 120s. */
	timeoutMs?: number;
}

/**
 * A minimal shape of the pi NDJSON `message_end` payload we consume. pi emits
 * one JSON object per line in `--mode json`; we only read assistant text and
 * usage. Unknown fields are ignored.
 */
interface PiMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
	};
	errorMessage?: string;
}

/**
 * Resolve how to invoke pi.
 *
 * CRITICAL SAFETY: we must spawn the pi CLI, never re-run whatever script
 * happens to be `process.argv[1]`. Naively re-running the current script (as the
 * example subagent extension does) is a fork bomb when the current process is
 * anything other than pi itself (e.g. a test runner, tsx, a harness tool): each
 * worker would recursively re-run that script, which spawns more workers, ad
 * infinitum. We therefore only reuse the current entrypoint when it is
 * demonstrably pi's own binary/script; otherwise we resolve the `pi` CLI on
 * PATH.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun|tsx|deno)(\.exe)?$/.test(execName);

	// A compiled pi binary: process.execPath IS pi. Safe to reuse directly.
	if (!isGenericRuntime && /(^|[/\\])pi(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}

	// A generic runtime (node/bun/tsx) running a script: only reuse the script if
	// it is genuinely pi's entrypoint. Anything else (tests, tools, ad-hoc
	// scripts) must NOT be re-run — that is the fork-bomb path.
	const looksLikePiEntry =
		!!currentScript &&
		!currentScript.startsWith("/$bunfs/root/") &&
		/(^|[/\\])(pi|coding-agent)([/\\]|[.-])/i.test(currentScript) &&
		fs.existsSync(currentScript);
	if (looksLikePiEntry && currentScript) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	// Default: the pi CLI on PATH. This is the only safe fallback.
	return { command: "pi", args };
}

/** Extract the last assistant text message from the collected pi messages. */
function finalAssistantText(messages: PiMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text" && typeof part.text === "string") return part.text;
			}
		}
	}
	return "";
}

/** Best-effort parse of a JSON object out of a text blob (for schema-constrained output). */
function tryParseStructured(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		// Fall back to the first {...} or [...] block if the model wrapped it in prose.
		const match = trimmed.match(/[[{][\s\S]*[\]}]/);
		if (match) {
			try {
				return JSON.parse(match[0]);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

/** Write a system prompt to a temp file and return its path (pi reads it via @file/flag). */
function writeSystemPromptFile(workerId: string, systemPrompt: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `maorch-${workerId}-`));
	const filePath = path.join(dir, "system-prompt.md");
	fs.writeFileSync(filePath, systemPrompt, "utf8");
	return filePath;
}

/**
 * Spawn a single headless pi worker and collect its structured result.
 *
 * Never throws for worker-level failures: a failed worker returns a
 * `WorkerResult` with `success: false` and an `error`, so a pattern can decide
 * how to handle partial failure without one worker aborting the whole batch.
 */
export async function spawnWorker(options: SpawnWorkerOptions, signal?: AbortSignal): Promise<WorkerResult> {
	const start = Date.now();

	// Recursion guard: orchestration is strictly one level deep. If this process
	// is already an orchestrated worker, refuse to spawn another. Structural
	// fork-bomb prevention, independent of pi invocation resolution.
	if (currentDepth() >= MAX_DEPTH) {
		return {
			workerId: options.workerId,
			text: "",
			durationMs: 0,
			success: false,
			error: `refused: orchestration depth limit (${MAX_DEPTH}) reached; workers cannot orchestrate`,
		};
	}

	// Isolation guard: only "process" isolation is implemented. Rather than
	// silently running an unsupported isolation as a plain process (which would
	// give the caller a false sense of stronger isolation than they got), fail
	// explicitly. "worktree" is a declared-but-unimplemented future addition.
	if (options.isolation && options.isolation !== "process") {
		return {
			workerId: options.workerId,
			text: "",
			durationMs: 0,
			success: false,
			error: `refused: isolation "${options.isolation}" is not implemented; only "process" isolation is supported`,
		};
	}

	const tools = sanitizeWorkerTools(options.tools);
	const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;

	// Headless, sessionless, no extensions (prevents recursive sub-agent spawning),
	// structured NDJSON output.
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--tools", tools.join(",")];
	if (options.model) args.push("--model", options.model);
	if (options.provider) args.push("--provider", options.provider);
	if (options.thinking) args.push("--thinking", options.thinking);

	let systemPromptPath: string | null = null;
	if (options.systemPrompt?.trim()) {
		systemPromptPath = writeSystemPromptFile(options.workerId, options.systemPrompt);
		args.push("--append-system-prompt", systemPromptPath);
	}
	args.push(options.prompt);

	const messages: PiMessage[] = [];
	let stderr = "";
	let totalTokens = 0;
	// Accumulate usage across all assistant turns
	const usage: WorkerUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let errorMessage: string | undefined;
	let timedOut = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const child: ChildProcess = spawn(invocation.command, invocation.args, {
				cwd: options.cwd ?? process.cwd(),
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUB_AGENT: "1", [DEPTH_ENV]: String(currentDepth() + 1) },
			});

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: PiMessage };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					const msg = event.message;
					messages.push(msg);
					if (msg.role === "assistant") {
						if (msg.usage) {
							// Sum usage across all assistant turns
							usage.input += msg.usage.input ?? 0;
							usage.output += msg.usage.output ?? 0;
							usage.cacheRead += msg.usage.cacheRead ?? 0;
							usage.cacheWrite += msg.usage.cacheWrite ?? 0;
							if (msg.usage.cost) {
								usage.cost.input += msg.usage.cost.input ?? 0;
								usage.cost.output += msg.usage.cost.output ?? 0;
								usage.cost.cacheRead += msg.usage.cost.cacheRead ?? 0;
								usage.cost.cacheWrite += msg.usage.cost.cacheWrite ?? 0;
								usage.cost.total += msg.usage.cost.total ?? 0;
							}
							if (msg.usage.totalTokens) totalTokens = msg.usage.totalTokens; // legacy compat
						}
						if (msg.errorMessage) errorMessage = msg.errorMessage;
					}
				}
			};

			child.stdout?.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			child.on("error", () => resolve(1));

			// Kill the whole detached process group (negative pid) so pi's own
			// children die too, not just the pi parent.
			let killed = false;
			const killProc = () => {
				if (killed) return;
				killed = true;
				const pid = child.pid;
				try {
					if (pid) process.kill(-pid, "SIGTERM");
					else child.kill("SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
				setTimeout(() => {
					try {
						if (pid) process.kill(-pid, "SIGKILL");
						else if (!child.killed) child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}, TERM_GRACE_MS);
			};

			// Hard wall-clock timeout: a worker that never finishes is killed and
			// surfaces as a failed result rather than hanging the orchestration.
			const timer = setTimeout(() => {
				timedOut = true;
				killProc();
			}, timeoutMs);
			timer.unref?.();
			child.on("close", () => clearTimeout(timer));

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		const text = finalAssistantText(messages);
		const success = exitCode === 0 && !errorMessage && !timedOut;
		return {
			workerId: options.workerId,
			text,
			structured: options.schema ? tryParseStructured(text) : undefined,
			tokensUsed: totalTokens || undefined, // legacy compat
			usage: usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? usage : undefined,
			durationMs: Date.now() - start,
			success,
			error: success
				? undefined
				: timedOut
					? `worker timed out after ${timeoutMs}ms`
					: errorMessage || stderr.trim() || `exit code ${exitCode}`,
		};
	} catch (err) {
		return {
			workerId: options.workerId,
			text: "",
			durationMs: Date.now() - start,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (systemPromptPath) {
			try {
				fs.rmSync(path.dirname(systemPromptPath), { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}
}

/**
 * Run many worker specs with a concurrency cap. Failures do not abort the batch;
 * each result carries its own success/error. Results are returned in input order.
 */
export async function parallel(
	specs: SpawnWorkerOptions[],
	maxConcurrent: number,
	signal?: AbortSignal,
): Promise<WorkerResult[]> {
	const limit = Math.max(1, maxConcurrent);
	const results = new Array<WorkerResult>(specs.length);
	let next = 0;

	async function runLane(): Promise<void> {
		while (true) {
			const index = next++;
			if (index >= specs.length) return;
			results[index] = await spawnWorker(specs[index], signal);
		}
	}

	const lanes = Array.from({ length: Math.min(limit, specs.length) }, () => runLane());
	await Promise.all(lanes);
	return results;
}

/**
 * Assemble a worker's system prompt from a skeleton guard (the pattern's soul
 * step, hard-coded) plus the LLM-supplied focus. The guard always comes first so
 * the LLM cannot dilute it.
 */
export function buildSystemPrompt(guard: string, slot: WorkerSlot): string {
	const parts = [guard.trim()];
	if (slot.focus?.trim()) parts.push(`Focus:\n${slot.focus.trim()}`);
	if (slot.schema) {
		parts.push(`Return your final answer as JSON matching this schema:\n${JSON.stringify(slot.schema, null, 2)}`);
	}
	return parts.join("\n\n");
}

// ============================================================================
// Phase 1: Workflow primitives (Claude Code style API)
//
// These are composed by buildWorkflowContext in orchestrator.ts to build the
// WorkflowContext injected into every workflow module (presets and user
// scripts alike). The single-agent `agent`/`phase`/`log` primitives live as
// inline closures there (they need workflow-id + state-dir wiring); only the
// pure concurrency helpers below are shared here.
// ============================================================================

/**
 * Run a batch of agent tasks in parallel (对标 Claude Code 的 parallel()).
 *
 * @param tasks - Array of functions, each returning a Promise (typically agent calls)
 * @param maxConcurrent - Maximum concurrent workers (default 8)
 * @param signal - Abort signal
 * @returns Array of results in the same order as tasks
 */
export async function parallelAgents<T>(
	tasks: Array<() => Promise<T>>,
	maxConcurrent = 8,
	signal?: AbortSignal,
): Promise<T[]> {
	const limit = Math.max(1, maxConcurrent);
	const results = new Array<T>(tasks.length);
	let next = 0;

	async function runLane(): Promise<void> {
		while (true) {
			const index = next++;
			if (index >= tasks.length) return;
			results[index] = await tasks[index]();
		}
	}

	const lanes = Array.from({ length: Math.min(limit, tasks.length) }, () => runLane());
	await Promise.all(lanes);
	return results;
}

/**
 * Stream-process items: don't wait for all to complete, push results as they finish (对标 Claude Code 的 pipeline()).
 *
 * Unlike parallelAgents which returns results in input order, pipeline returns results
 * in completion order (useful for long-running tasks where you want early results).
 *
 * @param items - Input array
 * @param fn - Async function to apply to each item
 * @param maxConcurrent - Maximum concurrent workers (default 8)
 * @param signal - Abort signal
 * @returns Array of results in completion order (not input order)
 */
export async function pipeline<T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	maxConcurrent = 8,
	signal?: AbortSignal,
): Promise<R[]> {
	const results: R[] = [];
	const limit = Math.max(1, maxConcurrent);
	let next = 0;

	async function runLane(): Promise<void> {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			const result = await fn(items[index], index);
			results.push(result); // Push in completion order
		}
	}

	const lanes = Array.from({ length: Math.min(limit, items.length) }, () => runLane());
	await Promise.all(lanes);
	return results;
}
