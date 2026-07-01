/**
 * Truncation helpers now live in the harness package (pure, no-render logic).
 * This module re-exports them from "@magenta/harness" so existing pi importers
 * (bash-executor, interactive-mode, bash-execution, tool renderers, and the
 * tools barrel) keep their stable import paths. Do not deep-import harness
 * internals here — everything comes through the package surface.
 */
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "@magenta/harness";
