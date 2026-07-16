import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	RichContentLink,
	type RichContentReference,
} from "../src/modes/interactive/components/rich-content-reference.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

beforeAll(() => {
	initTheme("dark");
});

function countOccurrences(text: string, value: string): number {
	return text.split(value).length - 1;
}

describe("RichContentLink width handling", () => {
	it.each([
		["long title", false, { metadata: { title: `report-${"very-long-title-".repeat(10)}` } }],
		["long title", true, { metadata: { title: `report-${"very-long-title-".repeat(10)}` } }],
		["long path", false, {}],
		["long path", true, {}],
	] as const)("bounds %s when focused is %s", (_caseName, focused, overrides) => {
		const reference: RichContentReference = {
			type: "pdf",
			path: `/tmp/${"nested-segment/".repeat(20)}report-with-a-long-name.pdf`,
			...overrides,
		};
		const link = new RichContentLink(
			reference,
			theme,
			() => {},
			() => {},
		);
		link.focused = focused;

		const [line] = link.render(20);

		expect(line).not.toMatch(/[\r\n]/);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(countOccurrences(line, OSC8_OPEN)).toBe(2);
		expect(countOccurrences(line, OSC8_CLOSE)).toBe(1);
		if (focused) {
			expect(line).toContain(CURSOR_MARKER);
			expect(line.indexOf(OSC8_CLOSE)).toBeLessThan(line.indexOf(CURSOR_MARKER));
		} else {
			expect(line).not.toContain(CURSOR_MARKER);
		}
	});

	it("keeps control characters out of the rendered line and hyperlink URI", () => {
		const reference: RichContentReference = {
			type: "file",
			path: "/tmp/a\r\nb.txt",
			metadata: { title: "line one\r\n\x1b]8;;https://example.com\x07line two\x1b]8;;\x07" },
		};
		const link = new RichContentLink(
			reference,
			theme,
			() => {},
			() => {},
		);

		const [line] = link.render(80);

		expect(line).not.toMatch(/[\r\n]/);
		expect(line).toContain("%0D%0A");
		expect(countOccurrences(line, OSC8_OPEN)).toBe(2);
		expect(countOccurrences(line, OSC8_CLOSE)).toBe(1);
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});
});
