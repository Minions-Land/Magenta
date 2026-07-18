import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const identity = (s: string) => s;

function makeTUI(): TUI {
	const terminal = new VirtualTerminal(80, 24);
	return new TUI(terminal);
}

function makeLoader(ui: TUI, message = "Loading..."): Loader {
	return new Loader(ui, identity, identity, message);
}

describe("Central animation scheduler", () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ["setInterval"] });
	});

	afterEach(() => {
		mock.timers.reset();
	});

	it("runs a single shared timer for multiple loaders", () => {
		const ui = makeTUI();
		assert.strictEqual(ui.animationTimerActive, false, "no timer before any loader starts");

		// Each Loader auto-starts via setIndicator() in the constructor.
		const loaders = [makeLoader(ui), makeLoader(ui), makeLoader(ui)];

		assert.strictEqual(ui.animationSubscriberCount, 3, "each loader registers one subscriber");
		assert.strictEqual(ui.animationTimerActive, true, "exactly one shared timer is active");

		// The shared timer advances every subscriber on each tick.
		mock.timers.tick(80);
		mock.timers.tick(80);
		assert.strictEqual(ui.animationSubscriberCount, 3, "subscriber count is stable across ticks");
		assert.strictEqual(ui.animationTimerActive, true);

		for (const loader of loaders) loader.stop();
	});

	it("clears the shared timer once all loaders stop (idle = 0 timers)", () => {
		const ui = makeTUI();
		const loaders = [makeLoader(ui), makeLoader(ui), makeLoader(ui)];
		assert.strictEqual(ui.animationTimerActive, true);

		loaders[0].stop();
		assert.strictEqual(ui.animationSubscriberCount, 2, "timer stays while subscribers remain");
		assert.strictEqual(ui.animationTimerActive, true);

		loaders[1].stop();
		assert.strictEqual(ui.animationSubscriberCount, 1);
		assert.strictEqual(ui.animationTimerActive, true);

		loaders[2].stop();
		assert.strictEqual(ui.animationSubscriberCount, 0, "no subscribers left");
		assert.strictEqual(ui.animationTimerActive, false, "shared timer is cleared when idle");
	});

	it("does not subscribe when frames animation is disabled", () => {
		const ui = makeTUI();
		// A single-frame indicator has nothing to animate.
		const loader = new Loader(ui, identity, identity, "static", { frames: ["*"] });
		assert.strictEqual(ui.animationSubscriberCount, 0, "single-frame loader does not subscribe");
		assert.strictEqual(ui.animationTimerActive, false);
		loader.stop();
	});

	it("subscribeAnimation returns an idempotent unsubscribe function", () => {
		const ui = makeTUI();
		let ticks = 0;
		const unsubscribe = ui.subscribeAnimation(() => {
			ticks++;
		});
		assert.strictEqual(ui.animationSubscriberCount, 1);
		assert.strictEqual(ui.animationTimerActive, true);

		mock.timers.tick(80);
		assert.strictEqual(ticks, 1, "callback fires once per tick");

		unsubscribe();
		assert.strictEqual(ui.animationSubscriberCount, 0);
		assert.strictEqual(ui.animationTimerActive, false);

		// Calling unsubscribe again is a no-op and must not throw or double-remove.
		unsubscribe();
		assert.strictEqual(ui.animationSubscriberCount, 0);

		mock.timers.tick(80);
		assert.strictEqual(ticks, 1, "no further ticks after unsubscribe");
	});

	it("tears down the shared timer on TUI.stop()", () => {
		const ui = makeTUI();
		makeLoader(ui);
		makeLoader(ui);
		assert.strictEqual(ui.animationTimerActive, true);

		ui.stop();
		assert.strictEqual(ui.animationSubscriberCount, 0, "stop() clears all subscribers");
		assert.strictEqual(ui.animationTimerActive, false, "stop() tears down the shared timer");
	});
});
