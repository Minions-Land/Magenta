import { describe, expect, it } from "vitest";
import type { BackgroundEventManager, MonitoredEvent } from "../src/core/background-events.ts";
import { PackageLoadController } from "../src/core/package-load-events.ts";

/**
 * A minimal stand-in for BackgroundEventManager that captures the source the
 * controller registers, so a test can read back the events it exposes and count
 * how often it asks for a re-render. This keeps the unit test focused on the
 * controller's own progress contract rather than the (separately tested)
 * manager rendering pipeline.
 */
function fakeManager(): { manager: BackgroundEventManager; events: () => MonitoredEvent[]; updates: () => number } {
	let getEvents: () => MonitoredEvent[] = () => [];
	let updateCount = 0;
	const manager = {
		registerSource(source: { getEvents: () => MonitoredEvent[] }) {
			getEvents = source.getEvents;
			return {
				update: () => {
					updateCount += 1;
				},
			};
		},
	} as unknown as BackgroundEventManager;
	return { manager, events: () => getEvents(), updates: () => updateCount };
}

describe("PackageLoadController", () => {
	it("exposes no event before assembly begins", () => {
		const { manager, events } = fakeManager();
		const controller = new PackageLoadController(manager);
		expect(events()).toEqual([]);
		void controller;
	});

	it("advances progress as components start and finish, then completes", () => {
		const { manager, events, updates } = fakeManager();
		const controller = new PackageLoadController(manager);

		controller.begin(2);
		expect(events()).toHaveLength(1);
		expect(events()[0].status).toBe("running");
		expect(events()[0].progress?.value).toBe(0);

		// First component starts: fraction stays at 0/2, label names it.
		controller.onProgress({
			phase: "start",
			index: 0,
			total: 2,
			component: { kind: "tool", name: "alpha" } as never,
		});
		expect(events()[0].progress?.value).toBe(0);
		expect(events()[0].label).toContain("alpha");
		expect(events()[0].label).toContain("1/2");

		// First component assembled: 1/2.
		controller.onProgress({
			phase: "assembled",
			index: 0,
			total: 2,
			component: { kind: "tool", name: "alpha" } as never,
		});
		expect(events()[0].progress?.value).toBe(0.5);

		// Second assembled: full.
		controller.onProgress({ phase: "start", index: 1, total: 2, component: { kind: "tool", name: "beta" } as never });
		controller.onProgress({
			phase: "assembled",
			index: 1,
			total: 2,
			component: { kind: "tool", name: "beta" } as never,
		});
		expect(events()[0].progress?.value).toBe(1);

		controller.finish();
		expect(events()[0].status).toBe("exited");
		expect(events()[0].progress?.value).toBe(1);
		expect(events()[0].endedAt).toBeGreaterThan(0);
		expect(updates()).toBeGreaterThan(0);
	});

	it("auto-begins if onProgress fires before begin()", () => {
		const { manager, events } = fakeManager();
		const controller = new PackageLoadController(manager);
		controller.onProgress({
			phase: "start",
			index: 0,
			total: 3,
			component: { kind: "capability", name: "x" } as never,
		});
		expect(events()).toHaveLength(1);
		expect(events()[0].status).toBe("running");
	});

	it("clamps the fraction to at most 1", () => {
		const { manager, events } = fakeManager();
		const controller = new PackageLoadController(manager);
		controller.begin(1);
		// index beyond total should not overshoot.
		controller.onProgress({
			phase: "assembled",
			index: 5,
			total: 1,
			component: { kind: "tool", name: "z" } as never,
		});
		expect(events()[0].progress?.value).toBe(1);
	});
});
