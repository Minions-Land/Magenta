import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { Session } from "../../core/session/pi/session.ts";
import type {
	BranchSummaryError,
	BranchSummaryResult,
	CompactionError,
	Result,
	SessionTreeEntry,
} from "../../core/types/types.ts";
import type { CollectEntriesResult, GenerateBranchSummaryOptions } from "./pi/branch-summarization.ts";
import type { CompactionPreparation, CompactionResult, CompactionSettings } from "./pi/compaction.ts";

/**
 * The compaction capability surface consumed by the agent loop. This is the
 * injection contract: the loop calls the source-selected provider instead of
 * statically importing `compact`/`prepareCompaction`, so the assembly layer
 * decides which source (pi, ...) supplies the behavior.
 */
export interface CompactionProvider {
	readonly defaultSettings: CompactionSettings;
	prepareCompaction(
		pathEntries: SessionTreeEntry[],
		settings: CompactionSettings,
	): Result<CompactionPreparation | undefined, CompactionError>;
	compact(
		preparation: CompactionPreparation,
		models: Models,
		model: Model<any>,
		customInstructions?: string,
		signal?: AbortSignal,
		thinkingLevel?: ThinkingLevel,
		streamFn?: StreamFn,
	): Promise<Result<CompactionResult, CompactionError>>;
	collectEntriesForBranchSummary(
		session: Session,
		oldLeafId: string | null,
		targetId: string,
	): Promise<CollectEntriesResult>;
	generateBranchSummary(
		entries: SessionTreeEntry[],
		options: GenerateBranchSummaryOptions,
	): Promise<Result<BranchSummaryResult, BranchSummaryError>>;
}

export type {
	CollectEntriesResult,
	GenerateBranchSummaryOptions,
} from "./pi/branch-summarization.ts";
// Re-export supporting types for convenience
export type {
	CompactionPreparation,
	CompactionResult,
	CompactionSettings,
} from "./pi/compaction.ts";
