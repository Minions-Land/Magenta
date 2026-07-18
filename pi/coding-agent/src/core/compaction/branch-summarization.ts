/**
 * Branch summarization for tree navigation.
 *
 * Thin adapter: the concrete summarization logic lives in @magenta/harness
 * (harness/compaction/pi/branch-summarization.ts). This module preserves pi's
 * public API surface and call signatures.
 *
 * Two things intentionally stay pi-local:
 *   1. `collectEntriesForBranchSummary` is kept as pi's SYNCHRONOUS impl over
 *      `ReadonlySessionManager` (agent-session.ts calls it synchronously). The
 *      harness variant is async and takes the harness `Session` abstraction, so
 *      it cannot be delegated without breaking pi's sync signature.
 *   2. The pi-shaped `BranchSummaryResult` (bare aborted/error object) and
 *      `GenerateBranchSummaryOptions` (explicit apiKey/headers/env/streamFn
 *      transport) differ from harness's variants (Result + Models DI), so they
 *      remain declared here.
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { SessionTreeEntry } from "@magenta/harness";
import {
	generateBranchSummary as harnessGenerateBranchSummary,
	prepareBranchEntries as harnessPrepareBranchEntries,
} from "@magenta/harness";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { createCompactionModels } from "./harness-models-adapter.ts";

// ============================================================================
// Types (pi-local: shapes differ from harness variants)
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "@magenta/harness";

import type { FileOperations } from "@magenta/harness";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	/**
	 * API key for the model. Optional: when omitted, the model's ambient/provider
	 * auth is used (Bedrock SigV4, Cloudflare, and other credential-free transports).
	 * CC-043 (upstream 7303cbac): summarization no longer requires an explicit key.
	 */
	apiKey?: string;
	/** Request headers for the model */
	headers?: Record<string, string>;
	/** Provider-scoped environment values for the model */
	env?: Record<string, string>;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	streamFn?: StreamFn;
}

// ============================================================================
// Entry Collection (pi-local SYNC impl — session-abstraction glue)
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * Kept pi-local + synchronous: agent-session.ts calls this synchronously and the
 * harness variant is async over the harness `Session` abstraction. This is
 * session glue, not compaction/summarization logic.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry Preparation (delegated to harness)
// ============================================================================

/**
 * Prepare entries for summarization with token budget.
 *
 * Delegates to harness. pi keeps its `SessionEntry[]` input signature; the entries
 * are structurally assignable to harness's `SessionTreeEntry[]` (pi's union is a
 * subset), so the cast is runtime-safe.
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	// Single (non-`unknown`) cast so TS flags any future structural drift between
	// pi's SessionEntry and harness's SessionTreeEntry (pi's union is a subset).
	return harnessPrepareBranchEntries(entries as SessionTreeEntry[], tokenBudget);
}

// ============================================================================
// Summary Generation (transport-aware wrapper)
// ============================================================================

/**
 * Generate a summary of abandoned branch entries.
 *
 * pi signature (unchanged): explicit apiKey/headers/env transport + optional
 * streamFn, returning the bare pi `BranchSummaryResult` shape. Delegates to
 * harness `generateBranchSummary` via the Models adapter and maps harness's
 * `Result` back to pi's bare object.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, headers, env, signal, customInstructions, replaceInstructions, reserveTokens, streamFn } =
		options;
	const models = createCompactionModels({ apiKey, headers, env, streamFn });
	const result = await harnessGenerateBranchSummary(entries as SessionTreeEntry[], {
		models,
		model,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens,
	});
	if (!result.ok) {
		if (result.error.code === "aborted") return { aborted: true };
		return { error: result.error.message };
	}
	const { summary, readFiles, modifiedFiles } = result.value;
	return { summary, readFiles, modifiedFiles };
}
