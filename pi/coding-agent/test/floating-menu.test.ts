import { beforeAll, describe, expect, it } from "vitest";
import {
	FloatingMenuBody,
	type FloatingMenuItem,
	FloatingOverlayContainer,
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
	it("does not forward key releases to ordinary overlay bodies", () => {
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

		expect(container.wantsKeyRelease).toBe(false);

		container.handleInput(KITTY_KEY_LEFT_RELEASE);

		expect(releaseEvents).toBe(0);
		expect(closed).toBe(false);
	});

	it("opts floating menus into key releases without closing on release events", () => {
		let closed = false;
		const container = new FloatingOverlayContainer(createMenu([{ value: "model", label: "Model" }]), () => {
			closed = true;
		});

		expect(container.wantsKeyRelease).toBe(true);

		container.handleInput(KITTY_KEY_LEFT_RELEASE);

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

	it("swallows left at the root so the overlay stays open", () => {
		const body = createMenu([
			{ value: "model", label: "Model" },
			{ value: "settings", label: "Settings" },
		]);

		// Left at the root must be consumed (true) and must not change the view.
		expect(body.handleInput(KEY_LEFT)).toBe(true);
		expect(renderText(body)).toContain("Model");
		expect(renderText(body)).toContain("Settings");
	});

	it("goes back with escape at an intermediate level, like left", () => {
		const body = createMenu([
			{
				value: "tools",
				label: "Tools",
				children: [{ value: "tools:on", label: "Enable all" }],
			},
		]);

		expect(body.handleInput(KEY_RIGHT)).toBe(true);
		expect(renderText(body)).toContain("Enable all");
		// Escape below the root goes back one level (consumed), it does not close.
		expect(body.handleInput(KEY_ESCAPE)).toBe(true);
		expect(renderText(body)).toContain("Tools");
	});

	it("swallows right on a leaf so only enter can confirm it", () => {
		const selected: string[] = [];
		const body = createMenu([{ value: "model", label: "Model" }], selected);

		// Right on a leaf is consumed (true) but must not select or close.
		expect(body.handleInput(KEY_RIGHT)).toBe(true);
		expect(selected).toEqual([]);
		// Enter is still required to confirm the leaf.
		expect(body.handleInput(KEY_ENTER)).toBe(true);
		expect(selected).toEqual(["model"]);
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

	it("keeps a held unmarked navigation key scrolling at a steady cadence", () => {
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

		// A burst of rapid unmarked repeats becomes a recognized hold; once held it
		// keeps moving one step per cadence instead of freezing after the burst.
		expect(body.handleInput(KEY_DOWN)).toBe(true);
		for (let i = 1; i <= 30; i++) {
			now = i * 10; // 10ms apart, faster than the 80ms cadence
			body.handleInput(KEY_DOWN);
		}
		// Selection has advanced past the burst limit (would freeze on "second" before).
		expect(body.handleInput(KEY_ENTER)).toBe(true);
		expect(selected).not.toEqual(["second"]);
		expect(selected.length).toBe(1);
	});

	it("resets hold tracking only when the tracked navigation key is released", () => {
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

		// Hold down: press then repeats are suppressed (one move).
		expect(body.handleInput(KITTY_KEY_DOWN_PRESS)).toBe(true);
		now = 20;
		expect(body.handleInput(KITTY_KEY_DOWN_REPEAT)).toBe(true);
		// A release for a DIFFERENT key must not reset down's hold tracking.
		now = 40;
		expect(body.handleInput(KITTY_KEY_LEFT_RELEASE)).toBe(true);
		now = 60;
		expect(body.handleInput(KITTY_KEY_DOWN_REPEAT)).toBe(true);
		now = 80;
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		// Only the initial press moved; both repeats stayed suppressed across the
		// unrelated release, so we are still on "second".
		expect(selected).toEqual(["second"]);
	});

	it("resets hold tracking when the tracked key is released so a fresh press moves", () => {
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

		expect(body.handleInput(KITTY_KEY_DOWN_PRESS)).toBe(true);
		now = 20;
		expect(body.handleInput(KITTY_KEY_DOWN_REPEAT)).toBe(true);
		// Releasing down clears tracking; the next press is a fresh tap that moves.
		now = 40;
		expect(body.handleInput(KITTY_KEY_DOWN_RELEASE)).toBe(true);
		now = 60;
		expect(body.handleInput(KITTY_KEY_DOWN_PRESS)).toBe(true);
		expect(body.handleInput(KEY_ENTER)).toBe(true);

		expect(selected).toEqual(["third"]);
	});
});
