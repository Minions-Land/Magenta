import { beforeAll, describe, expect, test } from "vitest";
import { Type } from "typebox";
import { type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

/**
 * Build a ToolDefinition that only declares a renderKind (no inline renderers),
 * mirroring how a harness process tool surfaces after
 * createToolDefinitionFromAgentTool: the renderer must be resolved from the
 * registry by renderKind alone.
 */
function createRenderKindDefinition(name: string, renderKind: string): ToolDefinition {
	return {
		name,
		label: name,
		description: "harness trunk tool",
		parameters: Type.Any(),
		renderKind,
		execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
	};
}

const SEARCH_OUTPUT = [
	"Provider: duckduckgo-instant-answer",
	"",
	"Rust is a systems programming language.",
	"",
	"## Sources (2)",
	"[1] Rust Programming Language",
	"    https://www.rust-lang.org",
	"    A language empowering everyone to build reliable software.",
	"[2] Rust (Wikipedia)",
	"    https://en.wikipedia.org/wiki/Rust_(programming_language)",
	"    Rust is a multi-paradigm language.",
	"",
].join("\n");

const FETCH_OUTPUT = [
	"URL: https://example.com",
	"Final-URL: https://example.com/",
	"Status: 200",
	"Content-Type: text/html",
	"Method: html-to-text",
	"",
	"---",
	"Example Domain",
	"This domain is for use in illustrative examples.",
].join("\n");

describe("web tool renderers (renderKind-routed)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("search-results renderer draws query, answer, and clickable sources", () => {
		const component = new ToolExecutionComponent(
			"WebSearch",
			"tool-search-1",
			{ query: "what is rust" },
			{},
			createRenderKindDefinition("WebSearch", "search-results"),
			createFakeTui(),
			process.cwd(),
		);

		// Call view shows the query.
		expect(stripAnsi(component.render(120).join("\n"))).toContain("what is rust");

		component.updateResult(
			{ content: [{ type: "text", text: SEARCH_OUTPUT }], details: {}, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Rust is a systems programming language.");
		expect(rendered).toContain("2 source(s)");
		expect(rendered).toContain("Rust Programming Language");
		expect(rendered).toContain("https://www.rust-lang.org");
		expect(rendered).toContain("empowering everyone");
	});

	test("web-content renderer draws url, metadata, and body", () => {
		const component = new ToolExecutionComponent(
			"WebFetch",
			"tool-fetch-1",
			{ url: "https://example.com" },
			{},
			createRenderKindDefinition("WebFetch", "web-content"),
			createFakeTui(),
			process.cwd(),
		);

		expect(stripAnsi(component.render(120).join("\n"))).toContain("https://example.com");

		component.updateResult(
			{ content: [{ type: "text", text: FETCH_OUTPUT }], details: {}, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("https://example.com");
		expect(rendered).toContain("Status: 200");
		expect(rendered).toContain("text/html");
		expect(rendered).toContain("This domain is for use in illustrative examples.");
	});

	test("search-results renderer falls back to raw text when output is unparseable", () => {
		const component = new ToolExecutionComponent(
			"WebSearch",
			"tool-search-2",
			{ query: "x" },
			{},
			createRenderKindDefinition("WebSearch", "search-results"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "totally unstructured blob" }], details: {}, isError: false },
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("totally unstructured blob");
	});
});
