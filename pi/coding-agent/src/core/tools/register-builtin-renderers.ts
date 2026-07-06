/**
 * Register the built-in tool renderers into the renderer registry, keyed by
 * data shape (renderKind) rather than tool name. Import this module once at
 * startup (before any ToolExecutionComponent renders) to populate the registry.
 *
 * Each built-in tool sets a `renderKind` on its ToolDefinition; the renderer
 * that draws that data shape is registered here. This is the pi-side (TUI)
 * half of the HCP client/server split: harness describes what data a tool
 * produces, pi decides how that shape is drawn.
 */

import { bashRenderer } from "./bash.ts";
import { editRenderer } from "./edit.ts";
import { findRenderer } from "./find.ts";
import { grepRenderer } from "./grep.ts";
import { lsRenderer } from "./ls.ts";
import { readRenderer } from "./read.ts";
import { registerRenderer } from "./renderer-registry.ts";
import { showRenderer } from "./show.ts";
import { searchResultsRenderer, webContentRenderer } from "./web-renderers.ts";
import { writeRenderer } from "./write.ts";

let registered = false;

/**
 * Register all built-in renderers. Idempotent — safe to call multiple times.
 */
export function registerBuiltinRenderers(): void {
	if (registered) return;
	registered = true;

	registerRenderer("file-content", readRenderer);
	registerRenderer("shell-output", bashRenderer);
	registerRenderer("text-edit", editRenderer);
	registerRenderer("file-write", writeRenderer);
	registerRenderer("pattern-search", grepRenderer);
	registerRenderer("file-search", findRenderer);
	registerRenderer("directory-list", lsRenderer);
	registerRenderer("file-preview", showRenderer);
	// Harness trunk web tools (web-search, web-fetch) declare these render kinds
	// via their manifest render_kind; the renderers parse the Rust tools' text.
	registerRenderer("search-results", searchResultsRenderer);
	registerRenderer("web-content", webContentRenderer);
}
