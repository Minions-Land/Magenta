/**
 * Shared utilities for compaction and branch summarization.
 *
 * Thin adapter: the concrete implementations live in @magenta/harness
 * (harness/compaction/pi/utils.ts). This module re-exports them so pi's public
 * surface (including the pi-owned placement of SUMMARIZATION_SYSTEM_PROMPT in
 * utils) stays byte-identical. Direct importers such as
 * compaction-serialization.test.ts keep working through this path.
 */

export type { FileOperations } from "@magenta/harness";
export {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "@magenta/harness";
