import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEventManager, type MonitoredEvent } from "../src/core/background-events.ts";
import { BackgroundReminderCoordinator } from "../src/core/background-reminder-coordinator.ts";

describe("BackgroundReminderCoordinator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(events: MonitoredEvent[]) {
		const manager = new BackgroundEventManager();
		const source = manager.registerSource({ id: "test", title: "test", getEvents: () => events });
		const upsertNextTurn = vi.fn();
		const removeNextTurn = vi.fn();
		const coordinator = new BackgroundReminderCoordinator(manager, {
			upsertNextTurn,
			removeNextTurn,
			thresholds: {
				expectedMultiplier: 1,
				expectedGraceMs: 0,
				expectedMinimumMs: 100,
				silentMs: 200,
			},
			batchWindowMs: 10,
			globalRateLimitMs: 500,
		});
		return { manager, source, coordinator, upsertNextTurn, removeNextTurn };
	}

	it("uses one deadline timer and batches expected-overdue and silent events", async () => {
		const events: MonitoredEvent[] = [
			{
				id: "expected",
				status: "running",
				startedAt: 0,
				label: "build",
				expectedSeconds: 0.1,
				lastActivityAt: 0,
				reminderEligible: true,
			},
			{
				id: "silent",
				status: "running",
				startedAt: -100,
				label: "worker",
				lastActivityAt: -100,
				reminderEligible: true,
			},
		];
		const { coordinator, upsertNextTurn } = setup(events);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(110);

		expect(upsertNextTurn).toHaveBeenCalledTimes(1);
		const message = upsertNextTurn.mock.calls[0]?.[1] as string;
		expect(message).toContain("test:expected");
		expect(message).toContain("overdue");
		expect(message).toContain("test:silent");
		expect(message).toContain("silent");
		expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
		coordinator.dispose();
	});

	it("does not treat synthetic time progress as activity and reminds once per stall epoch", async () => {
		const event: MonitoredEvent = {
			id: "job",
			status: "running",
			startedAt: 0,
			label: "job",
			lastActivityAt: 0,
			reminderEligible: true,
		};
		const { coordinator, source, upsertNextTurn } = setup([event]);
		event.progress = { value: 0.5, source: "time" };
		source.update();
		await vi.advanceTimersByTimeAsync(210);
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1_000);
		source.update();
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);

		event.lastActivityAt = Date.now();
		event.lastOutputAt = Date.now();
		source.update();
		await vi.advanceTimersByTimeAsync(210);
		expect(upsertNextTurn).toHaveBeenCalledTimes(2);
		coordinator.dispose();
	});

	it("rate-limits new epochs and removes queued reminders on completion/source removal/dispose", async () => {
		const first: MonitoredEvent = {
			id: "first",
			status: "running",
			startedAt: -200,
			label: "first",
			reminderEligible: true,
		};
		const second: MonitoredEvent = {
			id: "second",
			status: "running",
			startedAt: 0,
			label: "second",
			reminderEligible: true,
		};
		const events = [first, second];
		const { coordinator, source, upsertNextTurn, removeNextTurn } = setup(events);
		await vi.advanceTimersByTimeAsync(10);
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(200);
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(300);
		expect(upsertNextTurn).toHaveBeenCalledTimes(2);

		first.status = "exited";
		second.status = "exited";
		source.update();
		expect(removeNextTurn).toHaveBeenCalled();

		source.dispose();
		coordinator.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up a queued reminder when its source is removed", async () => {
		const event: MonitoredEvent = {
			id: "removed",
			status: "running",
			startedAt: -1_000,
			label: "removed",
			reminderEligible: true,
		};
		const { coordinator, source, upsertNextTurn, removeNextTurn } = setup([event]);
		await vi.advanceTimersByTimeAsync(10);
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);
		const removalsBefore = removeNextTurn.mock.calls.length;

		source.dispose();

		expect(removeNextTurn.mock.calls.length).toBeGreaterThan(removalsBefore);
		coordinator.dispose();
	});

	it("acknowledges a natural next-turn delivery without repeating the same stall epoch", async () => {
		const first: MonitoredEvent = {
			id: "first",
			status: "running",
			startedAt: -1_000,
			label: "first",
			reminderEligible: true,
		};
		const events = [first];
		const { coordinator, source, upsertNextTurn, removeNextTurn } = setup(events);
		await vi.advanceTimersByTimeAsync(10);
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);

		coordinator.markNextTurnDelivered();
		expect(removeNextTurn).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(600);
		expect(upsertNextTurn).toHaveBeenCalledTimes(1);

		events.push({
			id: "second",
			status: "running",
			startedAt: Date.now() - 1_000,
			label: "second",
			reminderEligible: true,
		});
		source.update();
		await vi.advanceTimersByTimeAsync(10);
		const latest = upsertNextTurn.mock.calls.at(-1)?.[1] as string;
		expect(latest).toContain("test:second");
		expect(latest).not.toContain("test:first");
		coordinator.dispose();
	});

	it("never reminds for sources that do not opt in or for parked idle teammates", async () => {
		const { coordinator, upsertNextTurn } = setup([
			{ id: "legacy", status: "running", startedAt: -1_000, label: "legacy" },
			{
				id: "idle",
				status: "running",
				startedAt: -1_000,
				label: "idle teammate",
				activityPhase: "idle",
				reminderEligible: false,
			},
		]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(upsertNextTurn).not.toHaveBeenCalled();
		coordinator.dispose();
	});
});
