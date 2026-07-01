import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
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

		expect(plain).toContain("tools - 3 calls");
		expect(plain).toContain("[running]");
		expect(plain).toContain("[success]");
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
});
