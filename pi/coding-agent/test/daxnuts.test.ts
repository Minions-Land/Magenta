import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DaxnutsComponent } from "../src/modes/interactive/components/daxnuts.ts";
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

function expectBounded(lines: string[], width: number): void {
	for (const line of lines) {
		expect(line).not.toMatch(/[\r\n]/);
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

describe("DaxnutsComponent width handling", () => {
	it.each([10, 20])("keeps image and text frames within %i columns", (width) => {
		const component = new DaxnutsComponent(createFakeTui());
		try {
			expectBounded(component.render(width), width);
			vi.advanceTimersByTime(3_000);
			expectBounded(component.render(width), width);
		} finally {
			component.dispose();
		}
	});
});
