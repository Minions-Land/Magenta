import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	ExternalActivationCoordinator,
	type ExternalActivationEntry,
} from "../src/core/external-activation-coordinator.ts";

function waitForDebounce(ms = 60): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backgroundEntry(id: string, overrides: Partial<ExternalActivationEntry> = {}): ExternalActivationEntry {
	return {
		key: `bg-shell:${id}`,
		source: { kind: "background", controller: "bg_shell", eventIds: [id] },
		consumeIds: [id],
		message: { customType: "bg-shell-return", content: id, display: true, details: { id } },
		delivery: "followUp",
		idlePolicy: "activate",
		...overrides,
	};
}

describe("ExternalActivationCoordinator", () => {
	let coordinator: ExternalActivationCoordinator;
	let deliveries: ExternalActivationEntry[][];

	beforeEach(() => {
		deliveries = [];
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				deliveries.push(entries);
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
		});
	});

	afterEach(async () => {
		await coordinator.shutdown();
	});

	test("coalesces different sources through the same batch path", async () => {
		coordinator.register(backgroundEntry("bg_001"));
		coordinator.register({
			key: "peer:steer:m_001",
			source: { kind: "peer", messageIds: ["m_001"] },
			consumeIds: ["m_001"],
			message: { customType: "magenta-peer-message", content: "peer", display: true, details: {} },
			delivery: "steer",
			idlePolicy: "activate",
		});

		await waitForDebounce();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((entry) => entry.source.kind)).toEqual(["background", "peer"]);
	});

	test("treats one submission as a one-element batch", async () => {
		coordinator.register(backgroundEntry("bg_single"));
		await coordinator.flushReady();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toHaveLength(1);
	});

	test("holds arrivals before and during a delivery barrier, then releases one coalesced batch", async () => {
		coordinator.register(backgroundEntry("before"));
		const release = await coordinator.acquireDeliveryBarrier();
		coordinator.register(
			backgroundEntry("during", {
				key: "sub-agent:during",
				source: { kind: "background", controller: "sub_agent", eventIds: ["during"] },
			}),
		);

		await coordinator.flushReady();
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);

		await release();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((entry) => entry.key)).toEqual(["bg-shell:before", "sub-agent:during"]);
	});

	test("reclaims a pre-latch Agent queue without rollback, duplicate ack, or loss", async () => {
		const persisted = vi.fn();
		const dropped = vi.fn();
		const cancelQueued = vi.fn(() => true);
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				deliveries.push(entries);
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
			cancelQueued,
		});
		coordinator.register(backgroundEntry("queued-before", { onPersisted: persisted, onInjectionError: dropped }));
		await coordinator.flushReady();

		const release = await coordinator.acquireDeliveryBarrier();
		expect(cancelQueued).toHaveBeenCalledOnce();
		expect(dropped).not.toHaveBeenCalled();
		await release();
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]?.map((entry) => entry.key)).toEqual(["bg-shell:queued-before"]);

		coordinator.markPersisted("bg-shell:queued-before");
		coordinator.markPersisted("bg-shell:queued-before");
		expect(persisted).toHaveBeenCalledOnce();
		expect(dropped).not.toHaveBeenCalled();
	});

	test("does not let an outer asynchronous release bypass a newly acquired barrier", async () => {
		let releaseInjection!: () => void;
		let injectionStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			injectionStarted = resolve;
		});
		const cancelQueued = vi.fn(() => true);
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				deliveries.push(entries);
				if (deliveries.length === 1) {
					injectionStarted();
					await new Promise<void>((resolve) => {
						releaseInjection = resolve;
					});
				}
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
			cancelQueued,
		});

		const releaseOuter = await coordinator.acquireDeliveryBarrier();
		coordinator.register(backgroundEntry("outer"));
		const outerSettlement = releaseOuter();
		await started;

		const nestedBarrier = coordinator.acquireDeliveryBarrier();
		coordinator.register(backgroundEntry("nested"));
		releaseInjection();
		const releaseNested = await nestedBarrier;
		await outerSettlement;
		await Promise.resolve();
		expect(deliveries).toHaveLength(1);

		await releaseNested();
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]?.map((entry) => entry.key)).toEqual(["bg-shell:nested", "bg-shell:outer"]);
	});

	test("cancels a pending entry by any consume id and rolls it back", async () => {
		const dropped = vi.fn();
		coordinator.register(
			backgroundEntry("sub_001", {
				key: "sub-agent:sub_001",
				source: { kind: "background", controller: "sub_agent", eventIds: ["sub_001", "sub_002"] },
				consumeIds: ["sub_001", "sub_002"],
				onInjectionError: dropped,
			}),
		);

		expect(coordinator.cancel(["sub_002"])).toBe(1);
		expect(coordinator.isPending("sub_001")).toBe(false);
		expect(dropped).toHaveBeenCalledOnce();
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);
	});

	test("removes a queued entry before terminal inline consumption", async () => {
		const removed: string[] = [];
		const dropped = vi.fn();
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
			cancelQueued: (entry) => {
				removed.push(entry.key);
				return true;
			},
		});
		coordinator.register(backgroundEntry("bg_queued", { onInjectionError: dropped }));
		await coordinator.flushReady();

		expect(coordinator.cancel(["bg_queued"])).toBe(1);
		expect(removed).toEqual(["bg-shell:bg_queued"]);
		expect(dropped).toHaveBeenCalledOnce();
	});

	test("does not cancel a payload already committed to model context", async () => {
		coordinator.register(backgroundEntry("bg_committed"));
		await coordinator.flushReady();
		coordinator.markCommitted("bg-shell:bg_committed");
		expect(coordinator.cancel(["bg_committed"])).toBe(0);
	});

	test("settles the source receipt only after persistence", async () => {
		const persisted = vi.fn();
		coordinator.register(backgroundEntry("bg_persisted", { onPersisted: persisted }));
		await coordinator.flushReady();
		expect(persisted).not.toHaveBeenCalled();
		coordinator.markPersisted("bg-shell:bg_persisted");
		expect(persisted).toHaveBeenCalledOnce();
		expect(coordinator.isPending("bg_persisted")).toBe(false);
	});

	test("flushReady seals the current window immediately and clears its timer", async () => {
		coordinator.register(backgroundEntry("bg_boundary"));
		await coordinator.flushReady();
		expect(deliveries).toHaveLength(1);
		await waitForDebounce();
		expect(deliveries).toHaveLength(1);
	});

	test("waitForQuiescence waits for an in-flight batch commit", async () => {
		let release!: () => void;
		let started = false;
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				started = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
		});
		coordinator.register(backgroundEntry("bg_wait"));

		const waiting = coordinator.waitForQuiescence({ timeoutMs: 1_000 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toBe(true);
		release();
		await expect(waiting).resolves.toBe(true);
	});

	test("waitForQuiescence yields to a scheduled turn-barrier release", async () => {
		const release = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("held-until-turn-end"));
		setTimeout(() => void release(), 10);

		await expect(coordinator.waitForQuiescence({ timeoutMs: 250 })).resolves.toBe(true);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((entry) => entry.key)).toEqual(["bg-shell:held-until-turn-end"]);
	});

	test("waitForQuiescence respects its deadline", async () => {
		let release!: () => void;
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
		});
		coordinator.register(backgroundEntry("bg_timeout"));
		await expect(coordinator.waitForQuiescence({ timeoutMs: 10 })).resolves.toBe(false);
		release();
		await coordinator.flushReady();
	});

	test("rolls back a failed injection without rejecting the AgentLoop", async () => {
		const errors: unknown[] = [];
		const dropped = vi.fn();
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async () => {
				throw new Error("persist failed");
			},
			onError: (error) => errors.push(error),
		});
		coordinator.register(backgroundEntry("bg_failed", { onInjectionError: dropped }));

		await expect(coordinator.flushReady()).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(dropped).toHaveBeenCalledOnce();
	});

	test("supersession explicitly rolls back the older entry", async () => {
		const dropped = vi.fn();
		coordinator.register(backgroundEntry("same", { onInjectionError: dropped }));
		coordinator.register(
			backgroundEntry("same", { message: { customType: "new", content: "new", display: true, details: {} } }),
		);
		expect(dropped).toHaveBeenCalledOnce();
		await coordinator.flushReady();
		expect(deliveries[0]?.[0]?.message.customType).toBe("new");
	});

	test("does not roll back a queued payload that shutdown cannot retract", async () => {
		const persisted = vi.fn();
		const dropped = vi.fn();
		await coordinator.shutdown();
		coordinator = new ExternalActivationCoordinator({
			injectBatch: async (entries) => {
				for (const entry of entries) coordinator.markQueued(entry.key);
			},
			cancelQueued: () => false,
		});
		coordinator.register(backgroundEntry("claimed", { onPersisted: persisted, onInjectionError: dropped }));
		await coordinator.flushReady();

		await coordinator.shutdown();
		expect(dropped).not.toHaveBeenCalled();
		expect(persisted).not.toHaveBeenCalled();
		expect(coordinator.isDeliverable("bg-shell:claimed")).toBe(true);

		coordinator.markPersisted("bg-shell:claimed");
		expect(persisted).toHaveBeenCalledOnce();
		expect(coordinator.isDeliverable("bg-shell:claimed")).toBe(false);
	});

	test("shutdown rejects new work and runs source rollback", async () => {
		await coordinator.shutdown();
		const dropped = vi.fn();
		coordinator.register(backgroundEntry("after_shutdown", { onInjectionError: dropped }));
		expect(dropped).toHaveBeenCalledOnce();
		expect(deliveries).toHaveLength(0);
	});

	test("turn barrier holds followUp but lets steer pass through", async () => {
		const release = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("held"));
		coordinator.register({
			key: "peer:steer:urgent",
			source: { kind: "peer", messageIds: ["urgent"] },
			consumeIds: ["urgent"],
			message: { customType: "magenta-peer-message", content: "urgent", display: true, details: {} },
			delivery: "steer",
			idlePolicy: "activate",
		});

		await waitForDebounce();
		// steer flushed through the barrier; followUp stayed coalesced
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((e) => e.key)).toEqual(["peer:steer:urgent"]);

		await release();
		// release commits the held followUp
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]?.map((e) => e.key)).toEqual(["bg-shell:held"]);
	});

	test("turn barrier coalesces multiple followUps into one release batch", async () => {
		const release = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("e1"));
		coordinator.register(backgroundEntry("e2"));
		coordinator.register(backgroundEntry("e3"));
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);

		await release();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((e) => e.key)).toEqual(["bg-shell:e1", "bg-shell:e2", "bg-shell:e3"]);
	});

	test("single followUp during a turn barrier still delivers on release (batch_size==1)", async () => {
		const release = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("solo"));
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);
		await release();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toHaveLength(1);
	});

	test("nextTurn stays held by the turn barrier until release", async () => {
		const release = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("later", { delivery: "nextTurn", idlePolicy: "passive" }));
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);
		await release();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.[0]?.delivery).toBe("nextTurn");
	});

	test("nested turn barriers only flush at the outermost release", async () => {
		const releaseA = await coordinator.acquireTurnBarrier();
		const releaseB = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("nested"));
		await releaseB();
		expect(deliveries).toHaveLength(0);
		await releaseA();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((e) => e.key)).toEqual(["bg-shell:nested"]);
	});

	test("compaction barrier supersedes an active turn barrier", async () => {
		const releaseTurn = await coordinator.acquireTurnBarrier();
		coordinator.register(backgroundEntry("pre"));
		// Compaction latches while a turn is in flight.
		const releaseCompaction = await coordinator.acquireDeliveryBarrier();
		coordinator.register(backgroundEntry("during"));
		// The now-defunct turn release must not flush; compaction owns the batch.
		await releaseTurn();
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);

		await releaseCompaction();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.map((e) => e.key)).toEqual(["bg-shell:pre", "bg-shell:during"]);
	});

	test("steer is blocked by compaction barrier even though it passes a turn barrier", async () => {
		await coordinator.acquireDeliveryBarrier();
		coordinator.register({
			key: "peer:steer:blocked",
			source: { kind: "peer", messageIds: ["blocked"] },
			consumeIds: ["blocked"],
			message: { customType: "magenta-peer-message", content: "blocked", display: true, details: {} },
			delivery: "steer",
			idlePolicy: "activate",
		});
		await waitForDebounce();
		expect(deliveries).toHaveLength(0);
	});

	test("waitForTurnBarrierReady resolves after release", async () => {
		const release = await coordinator.acquireTurnBarrier();
		let ready = false;
		const waiter = coordinator.waitForTurnBarrierReady().then(() => {
			ready = true;
		});
		await waitForDebounce(10);
		expect(ready).toBe(false);
		await release();
		await waiter;
		expect(ready).toBe(true);
	});
});
