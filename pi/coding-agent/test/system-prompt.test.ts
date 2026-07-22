import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("uses the caller-provided fixed date", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			currentDate: "2026-07-15",
		});

		expect(prompt).toContain("Current date: 2026-07-15");
	});

	test("does not inject the wall-clock date by default", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).not.toContain("Current date:");
	});

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading Magenta docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("custom and operational fragments", () => {
		test("custom prompt replaces default identity, tools, and docs but keeps active background operations", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "CUSTOM",
				appendSystemPrompt: "APPEND",
				selectedTools: ["sub_agent"],
				bundledPromptFeatures: { backgroundWork: true },
				contextFiles: [],
				skills: [],
				cwd: "/repo",
				currentDate: "2026-07-15",
			});

			expect(prompt).not.toContain("You are Magenta");
			expect(prompt).not.toContain("Available tools:");
			expect(prompt).not.toContain("Magenta documentation");
			expect(prompt).toContain("Use sub_agent for independent parallel analysis");
			expect(prompt.indexOf("CUSTOM")).toBeLessThan(prompt.indexOf("APPEND"));
			expect(prompt.indexOf("APPEND")).toBeLessThan(prompt.indexOf("# Background Work"));
		});

		test("does not mention background tools that are unavailable", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				bundledPromptFeatures: { backgroundWork: true },
				contextFiles: [],
				skills: [],
				cwd: "/repo",
				currentDate: "2026-07-15",
			});

			expect(prompt).not.toContain("# Background Work");
			expect(prompt).not.toContain("bg_shell");
			expect(prompt).not.toContain("sub_agent");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
