import { describe, expect, it, vi } from "vitest";
import { BackgroundEventManager, type MonitoredEvent } from "../src/core/background-events.ts";

describe("BackgroundEventManager headless APIs", () => {
	it("returns serializable source-qualified snapshots", () => {
		const manager = new BackgroundEventManager();
		const events: MonitoredEvent[] = [
			{
				id: "agent_001",
				status: "running",
				startedAt: 10,
				label: "review",
				progress: { value: 0.5, source: "output" },
				canCancel: true,
			},
		];
		const getUiTelemetry = vi.fn(() => ({ input: 123, cost: 1.25 }));
		manager.registerSource({ id: "agents", title: "agents", getEvents: () => events, getUiTelemetry });

		const snapshots = manager.getEvents();
		expect(snapshots).toEqual([
			expect.objectContaining({
				sourceId: "agents",
				sourceTitle: "agents",
				id: "agent_001",
				status: "running",
			}),
		]);
		expect(snapshots[0]?.progress).not.toBe(events[0]?.progress);
		expect(snapshots[0]).not.toHaveProperty("uiTelemetry");
		expect(snapshots[0]).not.toHaveProperty("input");
		expect(snapshots[0]).not.toHaveProperty("cost");
		expect(getUiTelemetry).not.toHaveBeenCalled();
	});

	it("waits for running work to settle", async () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = { id: "bg_001", status: "running", startedAt: 10, label: "build" };
		const monitor = manager.registerSource({ id: "shell", title: "shell", getEvents: () => [event] });

		const waiting = manager.waitForIdle({ timeoutMs: 1_000 });
		event.status = "exited";
		event.endedAt = 20;
		monitor.update();

		await expect(waiting).resolves.toBe(true);
	});

	it("returns false on timeout or disposal", async () => {
		const manager = new BackgroundEventManager();
		const event: MonitoredEvent = { id: "bg_001", status: "running", startedAt: 10, label: "server" };
		manager.registerSource({ id: "shell", title: "shell", getEvents: () => [event] });

		await expect(manager.waitForIdle({ timeoutMs: 1 })).resolves.toBe(false);
		const disposedWait = manager.waitForIdle();
		manager.dispose();
		await expect(disposedWait).resolves.toBe(false);
	});

	it("publishes telemetry snapshots and supports safe subscription/source removal", () => {
		const manager = new BackgroundEventManager();
		const listener = vi.fn();
		const unsubscribe = manager.subscribeChanges(listener);
		const event: MonitoredEvent = {
			id: "bg_telemetry",
			status: "running",
			startedAt: 10,
			label: "build",
			expectedSeconds: 60,
			lastActivityAt: 20,
			lastOutputAt: 20,
			lastProgressAt: 19,
			activityPhase: "compiling",
			reminderEligible: true,
		};
		const source = manager.registerSource({ id: "shell", title: "shell", getEvents: () => [event] });
		source.update();
		expect(manager.getEvents()[0]).toMatchObject({
			expectedSeconds: 60,
			lastActivityAt: 20,
			lastOutputAt: 20,
			lastProgressAt: 19,
			activityPhase: "compiling",
			reminderEligible: true,
		});
		expect(listener).toHaveBeenCalled();

		source.dispose();
		expect(manager.getEvents()).toEqual([]);
		const calls = listener.mock.calls.length;
		unsubscribe();
		manager.update();
		expect(listener).toHaveBeenCalledTimes(calls);
	});

	it("delegates cancellation to the owning source", () => {
		const cancelEvent = vi.fn(() => true);
		const manager = new BackgroundEventManager();
		manager.registerSource({ id: "agents", title: "agents", getEvents: () => [], cancelEvent });

		expect(manager.cancelEvent("agents", "agent_007")).toBe(true);
		expect(cancelEvent).toHaveBeenCalledWith("agent_007", undefined);
		expect(manager.cancelEvent("missing", "agent_007")).toBe(false);
	});
});
