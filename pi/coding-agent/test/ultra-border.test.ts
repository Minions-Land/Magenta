import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getThemeByName } from "../src/modes/interactive/theme/theme.ts";

describe("Ultra editor border", () => {
	it.each(["dark", "light"])("renders a width-stable theme-derived rainbow for %s", (themeName) => {
		const selectedTheme = getThemeByName(themeName);
		expect(selectedTheme).toBeDefined();
		const border = "─".repeat(21);
		const frames = [0, 1, 8].map((phase) => selectedTheme!.getUltraBorderColor(phase)(border));

		for (const output of frames) {
			expect(visibleWidth(output)).toBe(21);
			expect(stripVTControlCharacters(output)).toBe(border);
			expect(output.endsWith("\x1b[39m")).toBe(true);
			const foregrounds = new Set(output.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []);
			expect(foregrounds.size).toBeGreaterThan(3);
		}
		expect(frames[1]).not.toBe(frames[0]);
		expect(frames[2]).toBe(frames[1]);
	});

	it("preserves ANSI tokens and grapheme clusters without changing visible width", () => {
		const selectedTheme = getThemeByName("dark")!;
		const border = "\x1b[1m👩‍💻─\x1b[22m";
		const output = selectedTheme.getUltraBorderColor(3)(border);

		expect(stripVTControlCharacters(output)).toBe("👩‍💻─");
		expect(visibleWidth(output)).toBe(visibleWidth(border));
		expect(output).toContain("\x1b[1m");
		expect(output).toContain("\x1b[22m");
	});

	it("leaves empty border fragments empty", () => {
		const selectedTheme = getThemeByName("dark")!;
		expect(selectedTheme.getUltraBorderColor()("")).toBe("");
	});
});
