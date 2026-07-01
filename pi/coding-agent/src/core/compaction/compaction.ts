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
import type { SessionTreeEntry } from "@magenta/harness";
import {
	compact as harnessCompact,
	generateSummary as harnessGenerateSummary,
	prepareCompaction as harnessPrepareCompaction,
} from "@magenta/harness";
import type { SessionEntry } from "../session-manager.ts";
import { createCompactionModels } from "./harness-models-adapter.ts";

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
	if (!result.ok) throw result.error;
	return result.value;
}

/**
 * Prepare session entries for compaction, or return undefined when compaction
 * is not applicable. Synchronous in both pi and harness.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	const result = harnessPrepareCompaction(pathEntries as unknown as SessionTreeEntry[], settings);
	if (!result.ok) throw result.error;
	return result.value;
}

/**
 * Run compaction for a prepared session.
 *
 * pi signature (unchanged): compact(preparation, model, apiKey, ...). Delegates
 * to harness `compact`, injecting auth via the Models adapter, and unwraps
 * harness's `Result` (throws on error).
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
): Promise<CompactionResult> {
	const models = createCompactionModels({ apiKey, headers, env, streamFn });
	const result = await harnessCompact(preparation, models, model, customInstructions, signal, thinkingLevel);
	if (!result.ok) throw result.error;
	return result.value;
}
