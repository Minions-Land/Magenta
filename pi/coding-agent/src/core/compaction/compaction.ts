/**
 * Context compaction for long sessions.
 *
 * Thin adapter: the concrete compaction logic lives in @magenta/harness
 * (harness/compaction/pi/compaction.ts). This module preserves pi's public API
 * surface and call signatures (explicit apiKey/headers/env/streamFn transport,
 * throw-on-error instead of harness's `Result`), delegating the actual work to
 * harness through the Models adapter (harness-models-adapter.ts).
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { CompactionProvider, Result, SessionTreeEntry } from "@magenta/harness";
import {
	CompactionError,
	compact as harnessCompact,
	generateSummary as harnessGenerateSummary,
	prepareCompaction as harnessPrepareCompaction,
} from "@magenta/harness";
import type { SessionEntry } from "../session-manager.ts";
import { createCompactionModels } from "./harness-models-adapter.ts";

export type { CompactionErrorCode } from "@magenta/harness";
// Re-export the harness error type + its stable code union so callers can branch
// on `error.code` (backend-independent) instead of matching on message text.
export { CompactionError } from "@magenta/harness";

/**
 * Unwrap a harness `Result`, preserving pi's historical throw semantics.
 *
 * Before the harness migration, an in-flight abort surfaced as a rejected
 * completion whose `error.name === "AbortError"`; pi's callers (agent-session.ts)
 * branch on that name to distinguish user-cancel from genuine failure. harness
 * instead resolves aborts to `err(CompactionError("aborted", ...))`, which has a
 * different name and message. To keep pi's cancel-vs-fail detection working
 * without touching every call site, re-tag the aborted case with the historical
 * `name = "AbortError"` before rethrowing. Non-abort errors rethrow unchanged
 * (they remain `CompactionError` instances, so `error.code` is still available).
 */
function unwrap<T>(result: Result<T, CompactionError>): T {
	if (result.ok) return result.value;
	const error = result.error;
	if (error instanceof CompactionError && error.code === "aborted") {
		error.name = "AbortError";
	}
	throw error;
}

// ============================================================================
// Pure re-exports (types + pure functions delegated straight to harness)
// ============================================================================

export type {
	CompactionDetails,
	CompactionPreparation,
	CompactionResult,
	CompactionSettings,
	ContextUsageEstimate,
	CutPointResult,
} from "@magenta/harness";
export {
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	getLastAssistantUsage,
	shouldCompact,
} from "@magenta/harness";

// Import the pure delegated symbols locally for wrapper signatures below.
import type { CompactionPreparation, CompactionResult, CompactionSettings } from "@magenta/harness";

// ============================================================================
// Transport-aware wrappers (preserve pi's explicit-auth call signatures)
// ============================================================================

/**
 * Generate a summary of the given messages.
 *
 * pi signature (unchanged): explicit apiKey/headers/env transport + optional
 * streamFn. Delegates to harness `generateSummary`, injecting auth via the
 * Models adapter, and unwraps harness's `Result` (throws on error).
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
): Promise<string> {
	const models = createCompactionModels({ apiKey, headers, env, streamFn });
	// Streaming is handled inside models.completeSimple; do NOT also pass streamFn
	// as the trailing harness param (that would double-route the request).
	const result = await harnessGenerateSummary(
		currentMessages,
		models,
		model,
		reserveTokens,
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
	);
	return unwrap(result);
}

/**
 * Prepare session entries for compaction, or return undefined when compaction
 * is not applicable. Synchronous in both pi and harness.
 *
 * The compaction IMPL is injected via `provider` (resolved from the session HCP
 * as `resolveCapability("compaction")`); when omitted it falls back to the
 * statically imported harness function. Both paths are the SAME underlying
 * function (`piCompactionProvider.prepareCompaction === harnessPrepareCompaction`),
 * so behavior is identical — injection routes it through the HCP chain instead
 * of a direct import.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	provider?: CompactionProvider,
): CompactionPreparation | undefined {
	// Single (non-`unknown`) cast: pi's SessionEntry union is a structural subset
	// of harness's SessionTreeEntry, so this is assignable directly. Keeping it a
	// single cast (not `as unknown as`) means TS will error here if the two type
	// definitions ever drift apart, rather than silently masking the mismatch.
	const prepare = provider?.prepareCompaction ?? harnessPrepareCompaction;
	const result = prepare(pathEntries as SessionTreeEntry[], settings);
	return unwrap(result);
}

/**
 * Run compaction for a prepared session.
 *
 * pi signature (unchanged): compact(preparation, model, apiKey, ...). Delegates
 * to the injected `provider` (HCP-resolved compaction capability) or, when
 * omitted, the statically imported harness `compact`. Both are the same
 * function, so injection is behavior-identical and simply routes the call
 * through the HCP chain. Auth is injected via the Models adapter; harness's
 * `Result` is unwrapped (throws on error).
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	provider?: CompactionProvider,
): Promise<CompactionResult> {
	const models = createCompactionModels({ apiKey, headers, env, streamFn });
	const runCompact = provider?.compact ?? harnessCompact;
	const result = await runCompact(preparation, models, model, customInstructions, signal, thinkingLevel);
	return unwrap(result);
}
