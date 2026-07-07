import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
	renderToolCallActivity,
	renderToolCallGallery,
	renderToolCallStrip,
	type ToolCallTile,
} from "../src/modes/interactive/components/tool-call-gallery.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
});

function tile(index: number, status: ToolCallTile["status"] = "running"): ToolCallTile {
	return {
		id: `tool-${index}`,
		name: index % 2 === 0 ? "bash" : "read",
		args: index % 2 === 0 ? { command: `echo ${index}` } : { file_path: `src/file-${index}.ts` },
		status,
		output: `line ${index}\nlatest ${index}`,
		sortIndex: index,
	};
}

describe("tool-call gallery", () => {
	test("renders a width-bounded gallery for parallel calls", () => {
		const lines = renderToolCallGallery([tile(1), tile(2, "success"), tile(3, "error")], 80, { maxHeight: 8 });
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("tools · 3 calls");
		expect(plain).toContain("running");
		expect(plain).toContain("success");
		expect(plain).toContain("╭─");
		expect(plain).not.toContain("+-");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	test("shows overflow instead of spilling past the height budget", () => {
		const lines = renderToolCallGallery(
			Array.from({ length: 20 }, (_, index) => tile(index)),
			60,
			{ maxHeight: 4, minCellHeight: 4, preferredCellHeight: 4 },
		);

		expect(stripAnsi(lines.join("\n"))).toContain("more calls");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	test("renders a compact strip with active tally", () => {
		const lines = renderToolCallStrip([tile(1, "running"), tile(2, "success")], 50);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("tools");
		expect(plain).toContain("1/2 active");
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(50);
	});

	test("renders a compact activity summary for collapsed groups", () => {
		const lines = renderToolCallActivity([tile(1, "running"), tile(2, "success"), tile(3, "error")], 80);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("activity");
		expect(plain).toContain("tools ×3");
		expect(plain).toContain("✓1");
		expect(plain).toContain("▸1");
		expect(plain).toContain("✕1");
		expect(plain).toContain("Ctrl+o gallery");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	test("badges MCP-backed tools across gallery, strip, and activity views", () => {
		const mcpTile: ToolCallTile = {
			...tile(1, "running"),
			name: "bio_ensembl_info",
			provenance: { kind: "mcp", server: "aose-bio-mcp", remoteTool: "bio_ensembl_info" },
		};
		const gallery = stripAnsi(renderToolCallGallery([mcpTile], 80, { maxHeight: 8 }).join("\n"));
		expect(gallery).toContain("[mcp]");
		const strip = stripAnsi(renderToolCallStrip([mcpTile], 60).join("\n"));
		expect(strip).toContain("[mcp]");
		const activity = stripAnsi(renderToolCallActivity([mcpTile], 80).join("\n"));
		expect(activity).toContain("[mcp]");
	});
});
