/**
 * Edit-diff algorithm now lives in the harness package (pure, no-render logic).
 * Re-exported from "@magenta/harness" so existing pi importers (public index
 * re-exports, edit-tool/diff tests) keep their stable import paths.
 */
export {
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	normalizeForFuzzyMatch,
	applyReplacementsPreservingUnchangedLines,
	type FuzzyMatchResult,
	type Edit,
	type AppliedEditsResult,
	fuzzyFindText,
	stripBom,
	applyEditsToNormalizedContent,
	generateUnifiedPatch,
	generateDiffString,
	type EditDiffResult,
	type EditDiffError,
	computeEditsDiff,
	computeEditDiff,
} from "@magenta/harness";
