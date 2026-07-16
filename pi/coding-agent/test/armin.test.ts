import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function createFakeTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

describe("ArminComponent width handling", () => {
	it.each([10, 20])("keeps every line within %i columns", (width) => {
		const component = new ArminComponent(createFakeTui());
		try {
			const lines = component.render(width);
			for (const line of lines) {
				expect(line).not.toMatch(/[\r\n]/);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			component.dispose();
		}
	});
});
