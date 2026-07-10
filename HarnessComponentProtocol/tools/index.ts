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

// Shared utility modules live under utils/pi, not tools/<tool>. Re-export them
// here for the existing @magenta/harness tool-facing public surface.
export * from "../_magenta/utils/pi/edit-diff.ts";
export * from "../_magenta/utils/pi/file-mutation-queue.ts";
export * from "../_magenta/utils/pi/output-accumulator.ts";
export * from "../_magenta/utils/pi/path-utils.ts";
// Tools with no colliding export names.
export * from "./bash/pi/bash.ts";
export * from "./edit/pi/edit.ts";
// find — DEFAULT_LIMIT namespaced to avoid collision with grep/ls.
export {
	createFindExecute,
	DEFAULT_LIMIT as FIND_DEFAULT_LIMIT,
	defaultFindOperations,
	type FindExecuteDeps,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findSchema,
} from "./find/pi/find.ts";
// grep — DEFAULT_LIMIT namespaced to avoid collision with find/ls.
export {
	createGrepExecute,
	DEFAULT_LIMIT as GREP_DEFAULT_LIMIT,
	defaultGrepOperations,
	GREP_DESCRIPTION,
	GREP_PROMPT_SNIPPET,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepSchema,
	type ResolveRipgrep,
} from "./grep/pi/grep.ts";
// ls — DEFAULT_LIMIT namespaced to avoid collision with grep/find.
export {
	createLsExecute,
	DEFAULT_LIMIT as LS_DEFAULT_LIMIT,
	defaultLsOperations,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsSchema,
} from "./ls/pi/ls.ts";
export * from "./native-tool.ts";
export * from "./process-tool.ts";
export * from "./python-module-tool.ts";
export * from "./read/pi/read.ts";
export * from "./show/pi/show.ts";
// Tool abstraction surface (AgentTool contract + ToolFactory).
export * from "./tool.ts";
export * from "./tool-search/pi/tool-search.ts";
export * from "./write/pi/write.ts";
