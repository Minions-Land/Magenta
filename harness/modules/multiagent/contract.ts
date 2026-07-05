import type { HcpServer } from "../../hcp-contract/hcp-server.ts";

/**
 * Multi-agent orchestration contract.
 *
 * This module is NOT a sub-agent and NOT an agent team. It is a deterministic
 * WORKFLOW engine: each pattern is a fixed JavaScript control-flow skeleton that
 * spawns headless `pi` workers, routes their results, and terminates on explicit
 * conditions. The LLM never controls the flow — it only fills task-specific
 * content into the slots each pattern exposes.
 *
 * Design axiom: a pattern's value is not its shape, it is the step it forces the
 * LLM not to skip (classify-first, cover-every, independent re-check,
 * criteria-based scoring, pairwise judging, stop-on-no-new-findings). The
 * skeleton hard-codes that soul step via a guard prompt prepended to the
 * relevant worker; the LLM cannot dilute it.
 */

/** The set of supported orchestration patterns. */
export type Pattern =
	| "classify_and_act"
	| "fan_out_synthesize"
	| "adversarial_verify"
	| "generate_and_filter"
	| "tournament"
	| "loop_until_done";

/** Worker isolation level. `container` is a future addition. */
export type Isolation = "process" | "worktree";

/**
 * A single fill-in slot the LLM provides. The skeleton owns the surrounding
 * control flow; this is the only surface the LLM writes into.
 */
export interface WorkerSlot {
	/** What this worker does (LLM-supplied). */
	prompt: string;
	/** The standard/criteria this worker must attend to (LLM-supplied, optional). */
	focus?: string;
	/** JSON Schema constraining the worker's structured output (optional). */
	schema?: unknown;
	/** Model override for this worker, e.g. a stronger model for judging (optional). */
	model?: string;
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

/** The structured result of one worker run (shape aligned with AOSE AgentResult). */
export interface WorkerResult {
	workerId: string;
	/** The worker's final assistant text. */
	text: string;
	/** Parsed structured output, when the slot supplied a schema. */
	structured?: unknown;
	tokensUsed?: number;
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
	/** Confidence = passed / verifyCount, for adversarial_verify. */
	confidence?: number;
	/** Iterations executed, for loop_until_done. */
	iterations?: number;
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

/** Discriminated union of all orchestration requests. */
export type OrchestrationRequest =
	| ClassifyAndActRequest
	| FanOutSynthesizeRequest
	| AdversarialVerifyRequest
	| GenerateAndFilterRequest
	| TournamentRequest
	| LoopUntilDoneRequest;

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
