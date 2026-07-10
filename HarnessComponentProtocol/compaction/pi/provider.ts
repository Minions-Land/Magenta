import type { CompactionProvider } from "../HcpServer.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./branch-summarization.ts";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction.ts";

// Re-export contract and supporting types for backward compatibility
export type { CompactionProvider } from "../HcpServer.ts";

/** The pi implementation of the compaction capability. */
export const piCompactionProvider: CompactionProvider = {
	defaultSettings: DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	compact,
	collectEntriesForBranchSummary,
	generateBranchSummary,
};
