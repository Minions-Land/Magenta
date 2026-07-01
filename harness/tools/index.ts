/**
 * Public surface for harness tools: pure-execution tool logic (schemas, execute
 * factories, injectable operations, and types) plus the {@link AgentTool} Tool
 * contract. No rendering/TUI concerns live here — those stay in pi.
 *
 * Collision note: `bash`, `edit`, `read`, and `write` have no overlapping export
 * names and are re-exported wholesale. `grep`, `find`, and `ls` each export a
 * `DEFAULT_LIMIT` constant with a different value, so those three are re-exported
 * explicitly with the `DEFAULT_LIMIT` namespaced (`GREP_DEFAULT_LIMIT`,
 * `FIND_DEFAULT_LIMIT`, `LS_DEFAULT_LIMIT`) to avoid a name clash at this barrel.
 */

// Tool abstraction surface (AgentTool contract + ToolFactory).
export * from "./tool.ts";

// Tools with no colliding export names.
export * from "./bash/pi/bash.ts";
export * from "./edit/pi/edit.ts";
export * from "./read/pi/read.ts";
export * from "./write/pi/write.ts";

// grep — DEFAULT_LIMIT namespaced to avoid collision with find/ls.
export {
	grepSchema,
	type GrepToolInput,
	DEFAULT_LIMIT as GREP_DEFAULT_LIMIT,
	type GrepToolDetails,
	type GrepOperations,
	defaultGrepOperations,
	type ResolveRipgrep,
	type GrepToolOptions,
	GREP_DESCRIPTION,
	GREP_PROMPT_SNIPPET,
	createGrepExecute,
} from "./grep/pi/grep.ts";

// find — DEFAULT_LIMIT namespaced to avoid collision with grep/ls.
export {
	findSchema,
	type FindToolInput,
	DEFAULT_LIMIT as FIND_DEFAULT_LIMIT,
	type FindToolDetails,
	type FindOperations,
	defaultFindOperations,
	type FindToolOptions,
	type FindExecuteDeps,
	createFindExecute,
} from "./find/pi/find.ts";

// ls — DEFAULT_LIMIT namespaced to avoid collision with grep/find.
export {
	lsSchema,
	type LsToolInput,
	DEFAULT_LIMIT as LS_DEFAULT_LIMIT,
	type LsToolDetails,
	type LsOperations,
	defaultLsOperations,
	type LsToolOptions,
	createLsExecute,
} from "./ls/pi/ls.ts";

// Shared support modules. These are pure (no TUI) and are surfaced at the
// package level so pi can source them from "@magenta/harness" instead of
// keeping its own duplicate copies. truncate is intentionally NOT re-exported
// here — its symbols already reach the package surface via harness/utils/truncate,
// and re-exporting again would create an ambiguous duplicate barrel.
export * from "./support/edit-diff.ts";
export * from "./support/path-utils.ts";
export * from "./support/file-mutation-queue.ts";
export * from "./support/output-accumulator.ts";
