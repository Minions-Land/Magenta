import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	BackgroundReturnCoordinator,
	type BackgroundReturnMessage,
} from "../src/core/background-return-coordinator.ts";

type ReturnDelivery = "steer" | "followUp" | "nextTurn";

function waitForTick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForDebounce(ms = 60): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BackgroundReturnCoordinator", () => {
	let coordinator: BackgroundReturnCoordinator;
	let streaming = false;
	let singleDeliveries: Array<{ message: BackgroundReturnMessage; delivery: ReturnDelivery }> = [];
	let batchDeliveries: Array<Array<{ message: BackgroundReturnMessage; delivery: ReturnDelivery }>> = [];

	beforeEach(() => {
		streaming = false;
		singleDeliveries = [];
		batchDeliveries = [];
		coordinator = new BackgroundReturnCoordinator({
			isStreaming: () => streaming,
			injectSingle: async (message, delivery) => {
				singleDeliveries.push({ message, delivery });
			},
			injectBatch: async (entries) => {
				batchDeliveries.push(entries);
			},
		});
	});

	afterEach(() => {
		coordinator.shutdown();
	});

	test("idle: coalesces near-simultaneous returns into one batch after debounce", async () => {
		coordinator.register({
			key: "bg_001",
			eventIds: ["bg_001"],
			message: { customType: "bg-shell-return", content: "result1", display: true, details: { id: "bg_001" } },
			delivery: "followUp",
		});
		coordinator.register({
			key: "sub_001",
			eventIds: ["sub_001"],
			message: { customType: "sub-agent-return", content: "result2", display: true, details: { ids: ["sub_001"] } },
			delivery: "followUp",
		});

		// No immediate delivery (debounce pending)
		await waitForTick();
		expect(singleDeliveries).toHaveLength(0);
		expect(batchDeliveries).toHaveLength(0);

		// After debounce, one batch covering both
		await waitForDebounce();
		expect(singleDeliveries).toHaveLength(0);
		expect(batchDeliveries).toHaveLength(1);
		expect(batchDeliveries[0]).toHaveLength(2);
		expect(batchDeliveries[0]![0]!.message.customType).toBe("bg-shell-return");
		expect(batchDeliveries[0]![1]!.message.customType).toBe("sub-agent-return");
	});

	test("streaming: delivers immediately as single followUp, no debounce or batching", async () => {
		streaming = true;
		coordinator.register({
			key: "bg_002",
			eventIds: ["bg_002"],
			message: { customType: "bg-shell-return", content: "result", display: true, details: { id: "bg_002" } },
			delivery: "followUp",
		});

		await waitForTick();
		expect(singleDeliveries).toHaveLength(1);
		expect(singleDeliveries[0]!.message.customType).toBe("bg-shell-return");
		expect(batchDeliveries).toHaveLength(0);
	});

	test("cancel by single event id drops it from pending batch", async () => {
		coordinator.register({
			key: "bg_003",
			eventIds: ["bg_003"],
			message: { customType: "bg-shell-return", content: "result3", display: true, details: { id: "bg_003" } },
			delivery: "followUp",
		});
		coordinator.register({
			key: "bg_004",
			eventIds: ["bg_004"],
			message: { customType: "bg-shell-return", content: "result4", display: true, details: { id: "bg_004" } },
			delivery: "followUp",
		});

		// Cancel bg_003 (terminal wait consumed it)
		coordinator.cancel(["bg_003"]);

		await waitForDebounce();
		expect(batchDeliveries).toHaveLength(1);
		expect(batchDeliveries[0]).toHaveLength(1);
		expect(batchDeliveries[0]![0]!.message.details).toMatchObject({ id: "bg_004" });
	});

	test("cancel by member id drops sub-agent batch when any member is consumed", async () => {
		// Sub-agent batch covering three events
		coordinator.register({
			key: "sub_002",
			eventIds: ["sub_002", "sub_003", "sub_004"],
			message: {
				customType: "sub-agent-return",
				content: "batch result",
				display: true,
				details: { ids: ["sub_002", "sub_003", "sub_004"] },
			},
			delivery: "followUp",
		});

		expect(coordinator.isPending("sub_002")).toBe(true);
		expect(coordinator.isPending("sub_003")).toBe(true);

		// Consume sub_003 via terminal wait/status
		coordinator.cancel(["sub_003"]);

		// Entire batch is cancelled (any member consumption drops it)
		expect(coordinator.isPending("sub_002")).toBe(false);
		expect(coordinator.isPending("sub_003")).toBe(false);

		await waitForDebounce();
		expect(batchDeliveries).toHaveLength(0);
	});

	test("cancelling all pending entries clears the timer", async () => {
		coordinator.register({
			key: "bg_005",
			eventIds: ["bg_005"],
			message: { customType: "bg-shell-return", content: "result5", display: true, details: { id: "bg_005" } },
			delivery: "followUp",
		});

		coordinator.cancel(["bg_005"]);

		// No batch is delivered even after debounce (timer was cleared)
		await waitForDebounce();
		expect(batchDeliveries).toHaveLength(0);
	});

	test("register after shutdown is a no-op", async () => {
		coordinator.shutdown();
		coordinator.register({
			key: "bg_006",
			eventIds: ["bg_006"],
			message: { customType: "bg-shell-return", content: "result6", display: true, details: { id: "bg_006" } },
			delivery: "followUp",
		});

		await waitForDebounce();
		expect(singleDeliveries).toHaveLength(0);
		expect(batchDeliveries).toHaveLength(0);
	});

	test("flush during a turn that started after register routes to streaming path", async () => {
		coordinator.register({
			key: "bg_007",
			eventIds: ["bg_007"],
			message: { customType: "bg-shell-return", content: "result7", display: true, details: { id: "bg_007" } },
			delivery: "followUp",
		});

		// Turn starts before debounce fires
		streaming = true;
		await waitForDebounce();

		// The timer fired while streaming, so entries were handed to injectSingle
		expect(singleDeliveries).toHaveLength(1);
		expect(batchDeliveries).toHaveLength(0);
	});

	test("flushReady delivers queued returns immediately without waiting for debounce", async () => {
		coordinator.register({
			key: "bg_008",
			eventIds: ["bg_008"],
			message: { customType: "bg-shell-return", content: "result8", display: true, details: { id: "bg_008" } },
			delivery: "followUp",
		});

		// Turn boundary reached before the debounce timer fires.
		coordinator.flushReady();
		await waitForTick();

		expect(batchDeliveries).toHaveLength(1);
		expect(batchDeliveries[0]).toHaveLength(1);
		expect(batchDeliveries[0]![0]!.message.details).toMatchObject({ id: "bg_008" });

		// The armed timer was cleared, so no second delivery fires later.
		await waitForDebounce();
		expect(batchDeliveries).toHaveLength(1);
	});

	test("flushReady is a no-op when nothing is queued", async () => {
		coordinator.flushReady();
		await waitForDebounce();
		expect(singleDeliveries).toHaveLength(0);
		expect(batchDeliveries).toHaveLength(0);
	});
});
