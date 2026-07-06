import { describe, expect, it } from "vitest";
import { stripComponentBorders } from "../src/modes/interactive/components/central-overlay.ts";

describe("stripComponentBorders", () => {
	it("strips colored border-only lines", () => {
		const lines = ["\x1b[90m────\x1b[39m", "", "content", "", "\x1b[90m────\x1b[39m"];

		expect(stripComponentBorders(lines)).toEqual(["content"]);
	});
});
