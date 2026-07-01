/**
 * Edit-diff algorithm now lives in the harness package (pure, no-render logic).
 * Re-exported from "@magenta/harness" so existing pi importers (public index
 * re-exports, edit-tool/diff tests) keep their stable import paths.
 */
export {
	type AppliedEditsResult,
	applyEditsToNormalizedContent,
	applyReplacementsPreservingUnchangedLines,
	computeEditDiff,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	type FuzzyMatchResult,
	fuzzyFindText,
	generateDiffString,
	generateUnifiedPatch,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "@magenta/harness";
