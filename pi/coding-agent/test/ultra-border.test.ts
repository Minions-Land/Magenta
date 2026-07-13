import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getThemeByName } from "../src/modes/interactive/theme/theme.ts";

describe("Ultra editor border", () => {
	it.each(["dark", "light"])("renders a width-stable theme-derived rainbow for %s", (themeName) => {
		const selectedTheme = getThemeByName(themeName);
		expect(selectedTheme).toBeDefined();
		const output = selectedTheme!.getUltraBorderColor()("─".repeat(21));

		expect(visibleWidth(output)).toBe(21);
		expect(stripVTControlCharacters(output)).toBe("─".repeat(21));
		expect(output.endsWith("\x1b[39m")).toBe(true);
		const foregrounds = new Set(output.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? []);
		expect(foregrounds.size).toBeGreaterThan(3);
	});

	it("leaves empty border fragments empty", () => {
		const selectedTheme = getThemeByName("dark")!;
		expect(selectedTheme.getUltraBorderColor()("")).toBe("");
	});
});
