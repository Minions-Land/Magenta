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
		manager.registerSource({ id: "agents", title: "agents", getEvents: () => events });

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

	it("delegates cancellation to the owning source", () => {
		const cancelEvent = vi.fn(() => true);
		const manager = new BackgroundEventManager();
		manager.registerSource({ id: "agents", title: "agents", getEvents: () => [], cancelEvent });

		expect(manager.cancelEvent("agents", "agent_007")).toBe(true);
		expect(cancelEvent).toHaveBeenCalledWith("agent_007", undefined);
		expect(manager.cancelEvent("missing", "agent_007")).toBe(false);
	});
});
