import { beforeAll, describe, expect, it } from "vitest";
import { FloatingMenuBody, type FloatingMenuItem } from "../src/modes/interactive/components/floating-menu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const KEY_DOWN = "\x1b[B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

beforeAll(() => {
	initTheme("dark");
});

function renderText(body: FloatingMenuBody): string {
	return body.render(80, 12).body.join("\n");
}

function createMenu(items: FloatingMenuItem[], selected: string[] = []): FloatingMenuBody {
	return new FloatingMenuBody({
		title: "dock",
		items,
		onSelect: (item) => {
			selected.push(item.value);
			return undefined;
		},
		requestRender: () => undefined,
	});
}

describe("FloatingMenuBody", () => {
	it("filters root items while keeping nested matches selectable", () => {
		const body = createMenu([
			{ value: "model", label: "Model" },
			{
				value: "harness",
				label: "Harness",
				children: [{ value: "harness:skills", label: "Skills" }],
			},
		]);

		body.setFilter("skill");

		const rendered = renderText(body);
		expect(rendered).toContain("Harness");
		expect(rendered).not.toContain("Model");
	});

	it("opens children, goes back with left, and selects leaves", () => {
		const selected: string[] = [];
		const body = createMenu(
			[
				{
					value: "tools",
					label: "Tools",
					children: [{ value: "tools:on", label: "Enable all" }],
				},
				{ value: "model", label: "Model" },
			],
			selected,
		);

		expect(body.handleInput(KEY_RIGHT)).toBe(true);
		expect(renderText(body)).toContain("Enable all");

		expect(body.handleInput(KEY_LEFT)).toBe(true);
		expect(renderText(body)).toContain("Model");

		expect(body.handleInput(KEY_RIGHT)).toBe(true);
		expect(body.handleInput(KEY_ENTER)).toBe(true);
		expect(selected).toEqual(["tools:on"]);
	});

	it("returns undefined for escape at the root so the overlay can close", () => {
		const body = createMenu([{ value: "model", label: "Model" }]);

		expect(body.handleInput(KEY_ESCAPE)).toBeUndefined();
	});

	it("skips disabled items while moving", () => {
		const selected: string[] = [];
		const body = createMenu(
			[
				{ value: "disabled", label: "Disabled", disabled: true },
				{ value: "enabled", label: "Enabled" },
			],
			selected,
		);

		expect(body.handleInput(KEY_DOWN)).toBe(true);
		expect(body.handleInput(KEY_ENTER)).toBe(true);
		expect(selected).toEqual(["enabled"]);
	});
});
