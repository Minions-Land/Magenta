import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEventManager, type MonitoredEvent } from "../src/core/background-events.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

function createUiContext() {
	const setStatus = vi.fn();
	const requestRender = vi.fn();
	const theme = {
		fg: (_color: string, text: string) => text,
	};
	const custom = vi.fn(
		(factory: (...args: any[]) => unknown) =>
			new Promise<void>((resolve) => {
				factory({ requestRender }, theme, {}, resolve);
			}),
	);
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom,
			notify: vi.fn(),
			setStatus,
			theme,
		},
	} as unknown as ExtensionContext;
	return { ctx, custom, requestRender, setStatus };
}

describe("BackgroundEventManager UI refresh lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs the clock only for time progress or reminder-eligible work", async () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = {
			id: "teammate_001",
			status: "running",
			startedAt: 0,
			label: "idle teammate",
			activityPhase: "idle",
			reminderEligible: false,
		};
		const monitor = manager.registerSource({ id: "teammates", title: "teammates", getEvents: () => [event] });
		const listener = vi.fn();
		manager.subscribeChanges(listener);
		const { ctx, setStatus } = createUiContext();

		monitor.update(ctx);
		expect(vi.getTimerCount()).toBe(0);
		expect(setStatus).toHaveBeenCalledTimes(1);

		event.progress = { value: 0.1, source: "time" };
		monitor.update();
		expect(vi.getTimerCount()).toBe(1);
		const changeCallsBeforeTick = listener.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(listener).toHaveBeenCalledTimes(changeCallsBeforeTick);

		event.progress = { value: 0.2, source: "output" };
		monitor.update();
		expect(vi.getTimerCount()).toBe(0);

		event.reminderEligible = true;
		monitor.update();
		expect(vi.getTimerCount()).toBe(1);

		event.status = "terminating";
		event.progress = { value: 0.3, source: "time" };
		monitor.update();
		expect(vi.getTimerCount()).toBe(0);

		event.status = "cancelled";
		event.endedAt = 2_000;
		monitor.update();
		expect(vi.getTimerCount()).toBe(0);
		expect(setStatus).toHaveBeenLastCalledWith("background-events", undefined);
		manager.dispose();
	});

	it("refreshes elapsed time while the events overlay is visible", async () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = {
			id: "teammate_001",
			status: "running",
			startedAt: 0,
			label: "idle teammate",
			activityPhase: "idle",
			reminderEligible: false,
		};
		const monitor = manager.registerSource({ id: "teammates", title: "teammates", getEvents: () => [event] });
		const { ctx, custom, requestRender } = createUiContext();
		monitor.update(ctx);
		expect(vi.getTimerCount()).toBe(0);

		const open = manager.handleCommand("open", ctx);
		await Promise.resolve();
		expect(custom).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(requestRender).toHaveBeenCalled();

		await manager.handleCommand("close", ctx);
		await open;
		expect(vi.getTimerCount()).toBe(0);
		manager.dispose();
	});

	it("stops the clock when eligible work ends but ordinary work remains", () => {
		const manager = new BackgroundEventManager();
		const eligible: MonitoredEvent = {
			id: "agent_001",
			status: "running",
			startedAt: 0,
			label: "review",
			reminderEligible: true,
		};
		const ordinary: MonitoredEvent = {
			id: "teammate_001",
			status: "running",
			startedAt: 1,
			label: "idle teammate",
			reminderEligible: false,
		};
		const events = [eligible, ordinary];
		const monitor = manager.registerSource({ id: "agents", title: "agents", getEvents: () => events });
		const { ctx, setStatus } = createUiContext();
		monitor.update(ctx);
		expect(vi.getTimerCount()).toBe(1);

		eligible.status = "exited";
		eligible.endedAt = 1_000;
		monitor.update();
		expect(vi.getTimerCount()).toBe(0);
		expect(setStatus.mock.calls.at(-1)?.[1]).toContain("1 running");

		ordinary.status = "exited";
		ordinary.endedAt = 2_000;
		monitor.update();
		expect(setStatus).toHaveBeenLastCalledWith("background-events", undefined);
		manager.dispose();
	});

	it("advances overdue footer state from the presentation heartbeat", async () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = {
			id: "bg_001",
			status: "running",
			startedAt: 0,
			label: "build",
			expectedSeconds: 0.01,
			reminderEligible: true,
		};
		const monitor = manager.registerSource({ id: "shell", title: "shell", getEvents: () => [event] });
		const listener = vi.fn();
		manager.subscribeChanges(listener);
		const { ctx, setStatus } = createUiContext();
		monitor.update(ctx);
		const changeCallsBeforeTicks = listener.mock.calls.length;

		await vi.advanceTimersByTimeAsync(60_000);

		expect(setStatus.mock.calls.at(-1)?.[1]).toContain("1 overdue");
		expect(listener).toHaveBeenCalledTimes(changeCallsBeforeTicks);
		manager.dispose();
	});

	it("clears an active presentation clock on disposal", () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = {
			id: "agent_001",
			status: "running",
			startedAt: 0,
			label: "review",
			reminderEligible: true,
		};
		const monitor = manager.registerSource({ id: "agents", title: "agents", getEvents: () => [event] });
		const { ctx, setStatus } = createUiContext();
		monitor.update(ctx);
		expect(vi.getTimerCount()).toBe(1);

		manager.dispose();

		expect(vi.getTimerCount()).toBe(0);
		expect(setStatus).toHaveBeenLastCalledWith("background-events", undefined);
	});

	it("stops the clock but keeps failed footer state when active work ends", () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = {
			id: "agent_001",
			status: "running",
			startedAt: 0,
			label: "review",
			reminderEligible: true,
		};
		const monitor = manager.registerSource({ id: "agents", title: "agents", getEvents: () => [event] });
		const { ctx, setStatus } = createUiContext();
		monitor.update(ctx);
		expect(vi.getTimerCount()).toBe(1);

		event.status = "failed";
		event.endedAt = 1_000;
		monitor.update();
		expect(vi.getTimerCount()).toBe(0);
		expect(setStatus.mock.calls.at(-1)?.[1]).toContain("1 failed");

		monitor.dispose();
		expect(setStatus).toHaveBeenLastCalledWith("background-events", undefined);
		expect(vi.getTimerCount()).toBe(0);
		manager.dispose();
	});
});
