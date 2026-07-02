import { beforeAll, describe, expect, it } from "vitest";
import {
	FloatingMenuBody,
	FloatingOverlayContainer,
	type FloatingMenuItem,
} from "../src/modes/interactive/components/floating-menu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const KEY_DOWN = "\x1b[B";
const KITTY_KEY_DOWN_PRESS = "\x1b[1;1:1B";
const KITTY_KEY_DOWN_REPEAT = "\x1b[1;1:2B";
const KITTY_KEY_DOWN_RELEASE = "\x1b[1;1:3B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KITTY_KEY_LEFT_RELEASE = "\x1b[1;1:3D";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

beforeAll(() => {
	initTheme("dark");
});

function renderText(body: FloatingMenuBody): string {
	return body.render(80, 12).body.join("\n");
}

function createMenu(
	items: FloatingMenuItem[],
	selected: string[] = [],
	options: Partial<ConstructorParameters<typeof FloatingMenuBody>[0]> = {},
): FloatingMenuBody {
	return new FloatingMenuBody({
		title: "dock",
		items,
		onSelect: (item) => {
			selected.push(item.value);
			return undefined;
		},
		requestRender: () => undefined,
		...options,
	});
}

describe("FloatingMenuBody", () => {
	it("opts the overlay into key releases and does not close on release events", () => {
		let releaseEvents = 0;
		let closed = false;
		const container = new FloatingOverlayContainer(
			{
				handleInput: (data) => {
					if (data === KITTY_KEY_LEFT_RELEASE) releaseEvents++;
					return undefined;
				},
				render: () => ({ title: "dock", body: [] }),
			},
			() => {
				closed = true;
			},
		);

		expect(container.wantsKeyRelease).toBe(true);

		container.handleInput(KITTY_KEY_LEFT_RELEASE);

		expect(releaseEvents).toBe(1);
		expect(closed).toBe(false);
	});

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

	it("allows rapid repeated navigation taps without key release metadata", () => {
		let now = 0;
		const selected: string[] = [];
		const body = createMenu(
			[
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
				{ value: "third", label: "Third" },
				{ value: "fourth", label: "Fourth" },
				{ value: "fifth", label: "Fifth" },
				{ value: "sixth", label: "Sixth" },
			],
			selected,
			{ navigationRepeatDelayMs: 80, now: () => now },
		);

		expect(body.handleInput(KEY_DOWN)).toBe(true);
		for (const time of [20, 40, 60, 80]) {
			now = time;
			expect(body.handleInput(KEY_DOWN)).toBe(true);
		}
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		expect(selected).toEqual(["sixth"]);
	});

	it("allows rapid Kitty press/release navigation taps", () => {
		let now = 0;
		const selected: string[] = [];
		const body = createMenu(
			[
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
				{ value: "third", label: "Third" },
				{ value: "fourth", label: "Fourth" },
			],
			selected,
			{ navigationRepeatDelayMs: 80, now: () => now },
		);

		for (const time of [0, 20, 40]) {
			now = time;
			expect(body.handleInput(KITTY_KEY_DOWN_PRESS)).toBe(true);
			expect(body.handleInput(KITTY_KEY_DOWN_RELEASE)).toBe(true);
		}
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		expect(selected).toEqual(["fourth"]);
	});

	it("suppresses Kitty navigation repeat events from a held key", () => {
		let now = 0;
		const selected: string[] = [];
		const body = createMenu(
			[
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
				{ value: "third", label: "Third" },
				{ value: "fourth", label: "Fourth" },
				{ value: "fifth", label: "Fifth" },
			],
			selected,
			{ navigationRepeatDelayMs: 80, now: () => now },
		);

		expect(body.handleInput(KITTY_KEY_DOWN_PRESS)).toBe(true);
		now = 20;
		expect(body.handleInput(KITTY_KEY_DOWN_REPEAT)).toBe(true);
		now = 40;
		expect(body.handleInput(KITTY_KEY_DOWN_REPEAT)).toBe(true);
		now = 60;
		expect(body.handleInput(KITTY_KEY_DOWN_REPEAT)).toBe(true);
		now = 80;
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		expect(selected).toEqual(["second"]);
	});

	it("suppresses unmarked held navigation after the initial repeat delay", () => {
		let now = 0;
		const selected: string[] = [];
		const body = createMenu(
			[
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
				{ value: "third", label: "Third" },
				{ value: "fourth", label: "Fourth" },
				{ value: "fifth", label: "Fifth" },
			],
			selected,
			{ navigationRepeatDelayMs: 80, now: () => now },
		);

		expect(body.handleInput(KEY_DOWN)).toBe(true);
		now = 300;
		expect(body.handleInput(KEY_DOWN)).toBe(true);
		now = 330;
		expect(body.handleInput(KEY_DOWN)).toBe(true);
		now = 360;
		expect(body.handleInput(KEY_DOWN)).toBe(true);
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		expect(selected).toEqual(["third"]);
	});

	it("allows the same navigation key after the repeat cadence breaks", () => {
		let now = 0;
		const selected: string[] = [];
		const body = createMenu(
			[
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
				{ value: "third", label: "Third" },
			],
			selected,
			{ navigationRepeatDelayMs: 80, now: () => now },
		);

		expect(body.handleInput(KEY_DOWN)).toBe(true);
		now = 81;
		expect(body.handleInput(KEY_DOWN)).toBe(true);
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		expect(selected).toEqual(["third"]);
	});
});
