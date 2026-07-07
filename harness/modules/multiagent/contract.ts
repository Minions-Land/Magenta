import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { HcpServer } from "../../hcp-contract/hcp-server.ts";

/**
 * Multi-agent orchestration contract.
 *
 * This module is NOT a sub-agent and NOT an agent team. It is a WORKFLOW
 * engine with a single execution path: every pattern is a workflow module
 * (`(args, ctx) => {...}`) that composes the injected primitives (agent,
 * parallelAgents, pipeline, guards), routes results, and terminates on explicit
 * conditions. The LLM never controls the flow — it only fills task-specific
 * content into the slots each preset exposes.
 *
 * The six named patterns are PRESET workflow scripts shipped in-tree; the
 * `script` pattern loads a user-authored module. Both run through the exact
 * same path (resolve module path → runWorkflowModule → assembleResult), so
 * choosing a preset and writing your own workflow are the same action — load a
 * module and run it — differing only in where the module comes from.
 *
 * Design axiom: a pattern's value is not its shape, it is the step it forces the
 * LLM not to skip (classify-first, cover-every, independent re-check,
 * criteria-based scoring, pairwise judging, stop-on-no-new-findings). Each preset
 * enforces that soul step via a guard prompt (see `guards`) prepended to the
 * relevant worker; the LLM cannot dilute it.
 */

/** The set of supported orchestration patterns. */
export type Pattern =
	| "classify_and_act"
	| "fan_out_synthesize"
	| "adversarial_verify"
	| "generate_and_filter"
	| "tournament"
	| "loop_until_done"
	| "script";

/** Worker isolation level. `container` is a future addition. */
export type Isolation = "process" | "worktree";

/**
 * A single fill-in slot the LLM provides. The skeleton owns the surrounding
 * control flow; this is the only surface the LLM writes into.
 *
 * This is a superset of pi's `AgentTask`: a single sub-agent is just a
 * one-node workflow, so a slot describes "how one agent runs" with the exact
 * same fields (`task`/`role`/`model`/`provider`/`tools`/`thinking`/timeout),
 * plus the orchestration-only extras `focus` and `schema`. Keeping the shapes
 * aligned lets the sub_agent facade route a lone task and a workflow slot
 * through one code path.
 */
export interface WorkerSlot {
	/** What this worker does (LLM-supplied). Mirrors AgentTask.task. */
	task: string;
	/** Optional role hint for the worker (LLM-supplied). */
	role?: string;
	/** The standard/criteria this worker must attend to (LLM-supplied, optional). */
	focus?: string;
	/**
	 * JSON Schema constraining the worker's structured output (optional).
	 * For verifier/judge/evaluator slots the skeleton overrides this with its
	 * own schema — the confidence/winner/score reads are the pattern's命根子
	 * and must not be diluted by the LLM.
	 */
	schema?: unknown;
	/** Model override for this worker, e.g. a stronger model for judging (optional). */
	model?: string;
	/** Provider override for this worker (optional). */
	provider?: string;
	/** Tool whitelist for this worker. Defaults to read-only (optional). */
	tools?: string[];
	/** Thinking level for this worker (optional). */
	thinking?: ThinkingLevel;
	/** Per-worker wall-clock timeout in seconds (optional). */
	timeoutSeconds?: number;
}

/** Options shared by every pattern request. */
export interface CommonOptions {
	/** Default model for all workers in this orchestration. */
	model?: string;
	/** Worker tool whitelist. Defaults to read-only tools. */
	tools?: string[];
	/** Max workers running concurrently. Defaults to 8. */
	maxConcurrent?: number;
	/** Worker isolation. Defaults to "process". */
	isolation?: Isolation;
	/** Working directory workers resolve against. Defaults to the module cwd. */
	cwd?: string;
}

/**
 * Token and cost usage for one worker. Aligns with the pi-ai Usage shape.
 * All fields are cumulative across the worker's full execution (multi-turn if
 * the worker runs multiple model calls).
 */
export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** The structured result of one worker run (shape aligned with AOSE AgentResult). */
export interface WorkerResult {
	workerId: string;
	/** The worker's final assistant text. */
	text: string;
	/** Parsed structured output, when the slot supplied a schema. */
	structured?: unknown;
	/** @deprecated Legacy field. Use `usage` for full breakdown. */
	tokensUsed?: number;
	/** Full token and cost usage, cumulative across all turns. */
	usage?: WorkerUsage;
	durationMs: number;
	success: boolean;
	error?: string;
}

/** Why an orchestration stopped. */
export type TerminationReason = "completed" | "max_iterations" | "threshold" | "budget";

/** The result of a full orchestration run. */
export interface OrchestrationResult {
	pattern: Pattern;
	/** Every worker that ran, in dispatch order. */
	workers: WorkerResult[];
	/** Synthesizer / winner / final output, when the pattern produces one. */
	outcome?: WorkerResult;
	/**
	 * Top-K candidates by score, highest first, for generate_and_filter when
	 * `keepTop > 1`. `outcome` is always `finalists[0]`. Omitted when only the
	 * single winner is kept.
	 */
	finalists?: WorkerResult[];
	/** Confidence = passed / verifyCount, for adversarial_verify. */
	confidence?: number;
	/** Iterations executed, for loop_until_done. */
	iterations?: number;
	/** Aggregated token/cost usage across all workers + outcome. */
	usage?: WorkerUsage;
	terminatedBy: TerminationReason;
}

// --- Per-pattern request shapes -------------------------------------------

export interface ClassifyAndActRequest extends CommonOptions {
	pattern: "classify_and_act";
	/** How to classify the input (schema constraining to an enum is recommended). */
	classifier: WorkerSlot;
	/** One handler worker per classification label. */
	handlers: Record<string, WorkerSlot>;
	/** Handler for an unmatched label (optional). */
	fallback?: WorkerSlot;
	/** The input to classify and act on. */
	input: string;
}

export interface FanOutSynthesizeRequest extends CommonOptions {
	pattern: "fan_out_synthesize";
	/** One task per object; the skeleton runs these in parallel over every input. */
	workers: WorkerSlot[];
	/** How to merge every worker result into one consolidated artifact. */
	synthesizer: WorkerSlot;
}

export interface AdversarialVerifyRequest extends CommonOptions {
	pattern: "adversarial_verify";
	/** Casts a wide net for candidate issues. */
	generator: WorkerSlot;
	/** How to independently re-check each candidate. */
	verifier: WorkerSlot;
	/** Number of independent verifiers. Defaults to 3. */
	verifyCount?: number;
	/** Confidence threshold to accept. Defaults to 0.8. */
	confidenceThreshold?: number;
}

export interface GenerateAndFilterRequest extends CommonOptions {
	pattern: "generate_and_filter";
	/** What to generate; the skeleton runs `count` diverse copies. */
	generator: WorkerSlot;
	/** Number of candidates to generate. */
	count: number;
	/** Scores each candidate against quantifiable criteria. */
	evaluator: WorkerSlot;
	/** Keep the top-K candidates by score. Defaults to 1. */
	keepTop?: number;
}

export interface TournamentRequest extends CommonOptions {
	pattern: "tournament";
	/** N distinct approaches/candidates. */
	approaches: WorkerSlot[];
	/** How to compare exactly two candidates (pairwise). */
	judge: WorkerSlot;
}

export interface LoopUntilDoneRequest extends CommonOptions {
	pattern: "loop_until_done";
	/** Starting content. */
	initial: string;
	/** How each round makes progress; the skeleton feeds prior findings back. */
	refine: WorkerSlot;
	/** Hard iteration cap. Defaults to 10. */
	maxIterations?: number;
}

/**
 * A single agent call issued from within a workflow script. Mirrors the
 * `agent()` primitive's option surface. The workflow author supplies the
 * prompt and per-call overrides; the runtime routes it through the same worker
 * runner as every other pattern, so the depth guard, tool denial, timeout, and
 * guard injection all still apply — a script cannot bypass them.
 */
export interface ScriptAgentOptions {
	/** Stable label for correlation / logging. */
	label?: string;
	/** JSON schema constraining the worker's structured output. */
	schema?: unknown;
	/** Model override. */
	model?: string;
	/** Provider override. */
	provider?: string;
	/** Thinking level. */
	thinking?: ThinkingLevel;
	/** Tool whitelist (still sanitized: sub_agent/bg_shell always stripped). */
	tools?: string[];
	/** A guard string prepended to the system prompt (the pattern's soul step). */
	guard?: string;
	/** Per-call wall-clock timeout in seconds. */
	timeoutSeconds?: number;
}

/**
 * The runtime context injected into a workflow module's default export. Presets
 * and user scripts alike compose these primitives to spawn work; a module never
 * imports the worker layer directly, so the runtime stays in control of routing
 * and safety.
 *
 * Best practices for composing these (the difference between a loop that
 * converges and one that spins):
 * - Separate the roles. Do not have one agent both produce and grade the same
 *   work; a generator asked "is this good?" says yes. Spawn an independent
 *   evaluator (see adversarial-verify.ts / tournament.ts for the pattern).
 * - Compute verdicts, never self-report them. Confidence, scores, and pass/fail
 *   should be derived from independent checks (e.g. passed/N verifiers), not
 *   asked of the worker that did the work.
 * - Own termination in code. The workflow decides when to stop (a cap, a
 *   no-new-findings round); never let a worker's "I'm done" end the loop.
 * - Use `guards` to force the soul step. A guard is a system-prompt prefix the
 *   worker cannot dilute — that is where a pattern's discipline lives.
 */
export interface WorkflowContext {
	/** Spawn one agent. Routes through the runtime's worker runner. */
	agent(prompt: string, options?: ScriptAgentOptions): Promise<WorkerResult>;
	/** Run a batch of task functions in parallel (results in input order). */
	parallelAgents<T>(tasks: Array<() => Promise<T>>, maxConcurrent?: number): Promise<T[]>;
	/** Stream-process items (results in completion order). */
	pipeline<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, maxConcurrent?: number): Promise<R[]>;
	/** Mark a named phase (observability; also written to the state dir). */
	phase(name: string): void;
	/** Write a log line (observability; appended to the run's log.jsonl). */
	log(message: string): void;
	/**
	 * Reusable guard atoms (the soul steps). Prepend one to a worker's system
	 * prompt via ScriptAgentOptions.guard to force the disciplined step the LLM
	 * would otherwise skip (classify-first, independent re-check, etc.).
	 */
	guards: Record<string, string>;
	/** This workflow run's id — also the ~/.magenta/tmp/<id> directory name. */
	workflowId: string;
	/** Working directory workers resolve against. */
	cwd: string;
	/** Abort signal for cooperative cancellation. */
	signal?: AbortSignal;
}

/** The shape a workflow script module must export. */
export interface WorkflowModule {
	/** Optional metadata for /events display. */
	meta?: {
		name: string;
		description: string;
		phases?: Array<{ title: string; detail: string }>;
	};
	/** The workflow entry point. Receives caller args + the injected context. */
	default: (args: unknown, context: WorkflowContext) => Promise<unknown>;
}

/**
 * Aggregate usage across multiple WorkerResults. Sums all fields. Returns
 * undefined if no worker reported usage (so consumers can distinguish "no data"
 * from "zero cost").
 */
export function aggregateWorkerUsage(workers: WorkerResult[]): WorkerUsage | undefined {
	const agg: WorkerUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasAnyUsage = false;
	for (const w of workers) {
		if (!w.usage) continue;
		hasAnyUsage = true;
		agg.input += w.usage.input;
		agg.output += w.usage.output;
		agg.cacheRead += w.usage.cacheRead;
		agg.cacheWrite += w.usage.cacheWrite;
		agg.cost.input += w.usage.cost.input;
		agg.cost.output += w.usage.cost.output;
		agg.cost.cacheRead += w.usage.cost.cacheRead;
		agg.cost.cacheWrite += w.usage.cost.cacheWrite;
		agg.cost.total += w.usage.cost.total;
	}
	return hasAnyUsage ? agg : undefined;
}

/**
 * Run a workflow authored as an executable TS/JS module (the "write the loop,
 * not the prompt" path). The script controls its own control flow (if/while/
 * await) using the injected primitives; the runtime enforces the safety
 * boundary. This is the flexible counterpart to the six fixed skeletons.
 */
export interface ScriptWorkflowRequest extends CommonOptions {
	pattern: "script";
	/** Absolute path to the workflow module (must export a default async fn). */
	scriptPath: string;
	/** Arguments passed to the workflow's default function. */
	args?: unknown;
}

/** Discriminated union of all orchestration requests. */
export type OrchestrationRequest =
	| ClassifyAndActRequest
	| FanOutSynthesizeRequest
	| AdversarialVerifyRequest
	| GenerateAndFilterRequest
	| TournamentRequest
	| LoopUntilDoneRequest
	| ScriptWorkflowRequest;

/** Result of the provider's discover() call. */
export interface MultiAgentDiscoverResult {
	provider: "multiagent";
	targets: string[];
	patterns: Pattern[];
}

/**
 * The multi-agent orchestration capability surface. The assembly layer selects
 * a source implementation and hands the loop this instance; the loop invokes
 * `orchestrate` directly (HCP does not sit on the hot path).
 */
export interface MultiAgentProviderContract {
	/** Describe the provider: its target and the patterns it supports. */
	discover(): MultiAgentDiscoverResult;
	/** Run one orchestration to completion. */
	orchestrate(request: OrchestrationRequest, signal?: AbortSignal): Promise<OrchestrationResult>;
	/** Expose this provider as an HCP server endpoint. */
	toHcpServer(): HcpServer;
}
