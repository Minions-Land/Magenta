import { describe, expect, test } from "vitest";
import {
	canonicalToolName,
	conciseToolErrorSummary,
	isEditToolName,
	resolveDisplayToolName,
	summarizeToolCall,
	toolOutputLooksFailed,
	toolProvenanceBadgeText,
	truncateMiddleDisplay,
} from "../src/core/tools/tool-display.ts";

describe("tool-display helpers", () => {
	test("canonicalizes provider and edit tool names", () => {
		expect(resolveDisplayToolName("shell_exec")).toBe("bash");
		expect(resolveDisplayToolName("file_read")).toBe("read");
		expect(resolveDisplayToolName("file_read", { file_path: "/some/file.ts" })).toBe("read");
		expect(resolveDisplayToolName("file_read", { file_path: "/path/to/skill-name/SKILL.md" })).toBe("skill");
		expect(canonicalToolName("ApplyPatch")).toBe("apply_patch");
		expect(canonicalToolName("skill")).toBe("skill");
		expect(isEditToolName("file_edit")).toBe(true);
		expect(isEditToolName("MultiEdit")).toBe(true);
		expect(isEditToolName("read")).toBe(false);
	});

	test("badges externally-backed tools by provenance", () => {
		expect(toolProvenanceBadgeText(undefined)).toBeUndefined();
		expect(toolProvenanceBadgeText({ kind: "mcp", server: "aose-bio-mcp", remoteTool: "bio_ensembl_info" })).toBe(
			"mcp",
		);
		expect(toolProvenanceBadgeText({ kind: "Process" })).toBe("process");
		expect(toolProvenanceBadgeText({ kind: "" })).toBeUndefined();
	});

	test("summarizes common tool inputs", () => {
		expect(summarizeToolCall({ name: "bash", args: { command: "npm run build -- --watch false" } }, 80)).toContain(
			"$ npm run build",
		);
		expect(
			summarizeToolCall(
				{
					name: "read",
					args: { file_path: "/Users/mjm/Magenta3/pi/coding-agent/src/index.ts", start_line: 10, end_line: 20 },
				},
				34,
			),
		).toContain("index.ts:10-20");
		expect(
			summarizeToolCall(
				{
					name: "apply_patch",
					args: { patch_text: "*** Begin Patch\n*** Update File: src/a.ts\n+hello\n*** End Patch" },
				},
				80,
			),
		).toContain("src/a.ts");
		expect(
			summarizeToolCall(
				{
					name: "file_read",
					args: { file_path: "/Users/mjm/Magenta3/harness/modules/skills/research-orchestration/pi/SKILL.md" },
				},
				80,
			),
		).toBe("research-orchestration");
		expect(
			summarizeToolCall(
				{
					name: "file_read",
					args: { file_path: "/path/to/my-skill/SKILL.md" },
				},
				50,
			),
		).toBe("my-skill");
	});

	test("detects and summarizes failed output", () => {
		expect(conciseToolErrorSummary("Error: missing field `command`")).toBe("invalid input: missing command");
		expect(conciseToolErrorSummary("--- Command finished with exit code: 2 ---")).toBe("exit 2");
		expect(toolOutputLooksFailed("Exit code: 1")).toBe(true);
		expect(toolOutputLooksFailed("Exit code: 0")).toBe(false);
	});

	test("middle truncation preserves both ends", () => {
		expect(truncateMiddleDisplay("abcdefghijklmnopqrstuvwxyz", 9)).toBe("abcd…wxyz");
	});
});
