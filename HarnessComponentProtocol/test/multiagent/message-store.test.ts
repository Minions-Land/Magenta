import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore } from "../../multiagent/message/message-store.ts";

/**
 * Storage-kernel invariants ported from MinionsOS2's eacn3::messages tests:
 * fire-once delivery, per-recipient addressing, delivery ordering, and the
 * atomicity guarantee that a message inserted after a drain still survives.
 * Plus the Magenta presence extension.
 */
describe("MessageStore", () => {
	let dir: string;
	let store: MessageStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "msgstore-"));
		store = new MessageStore(join(dir, "sub", "messages.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("delivers a sent message exactly once", () => {
		const id = store.send("kevin", "gru", "hello");
		const first = store.drainUnread("gru");
		expect(first).toHaveLength(1);
		expect(first[0].id).toBe(id);
		expect(first[0].sender).toBe("kevin");
		expect(first[0].content).toBe("hello");
		// Consumed: a second drain yields nothing.
		expect(store.drainUnread("gru")).toHaveLength(0);
	});

	it("generates distinct ids per send", () => {
		const a = store.send("kevin", "gru", "one");
		const b = store.send("kevin", "gru", "two");
		expect(a).not.toBe(b);
		expect(store.drainUnread("gru")).toHaveLength(2);
	});

	it("addresses messages per recipient", () => {
		store.send("kevin", "gru", "for gru");
		store.send("gru", "kevin", "for kevin");
		expect(store.drainUnread("gru")).toHaveLength(1);
		expect(store.drainUnread("kevin")).toHaveLength(1);
	});

	it("returns messages in created_at order", () => {
		store.send("kevin", "gru", "3");
		store.send("kevin", "gru", "1");
		store.send("kevin", "gru", "2");
		const drained = store.drainUnread("gru");
		expect(drained).toHaveLength(3);
		const times = drained.map((m) => m.createdAt);
		const sorted = [...times].sort();
		expect(times).toEqual(sorted);
	});

	it("still delivers a message inserted after a drain", () => {
		// Guards the atomicity fix: draining marks read ONLY the rows it
		// returns, so a later insert survives to the next drain.
		store.send("kevin", "gru", "first");
		expect(store.drainUnread("gru")).toHaveLength(1);
		store.send("kevin", "gru", "second");
		const drained = store.drainUnread("gru");
		expect(drained).toHaveLength(1);
		expect(drained[0].content).toBe("second");
	});

	it("drains every message that piled up from multiple senders at once", () => {
		// The "first thing on entering the loop is all unread" guarantee: many
		// senders queue while the recipient is busy; one drain returns them all
		// in send order.
		store.send("kevin", "gru", "from kevin");
		store.send("stuart", "gru", "from stuart");
		store.send("bob", "gru", "from bob");
		const drained = store.drainUnread("gru");
		expect(drained.map((m) => m.sender)).toEqual(["kevin", "stuart", "bob"]);
	});

	it("counts unread without consuming", () => {
		store.send("kevin", "gru", "a");
		store.send("kevin", "gru", "b");
		expect(store.unreadCount("gru")).toBe(2);
		// Non-consuming: still there after count.
		expect(store.drainUnread("gru")).toHaveLength(2);
	});

	describe("at-least-once delivery (drain → confirm/requeue)", () => {
		it("does not redeliver a drained message once it is confirmed delivered", () => {
			const id = store.send("kevin", "gru", "hello");
			const drained = store.drainUnread("gru");
			expect(drained).toHaveLength(1);
			store.markDelivered([id]);
			// Terminal state: never comes back, even after the staleness window.
			expect(store.drainUnread("gru")).toHaveLength(0);
			expect(store.unreadCount("gru")).toBe(0);
		});

		it("redelivers a drained message that was never confirmed, via requeue", () => {
			// Models an injection that failed after the drain claimed the message:
			// the caller returns it to unread so the next drain retries it.
			const id = store.send("kevin", "gru", "retry me");
			const first = store.drainUnread("gru");
			expect(first).toHaveLength(1);
			store.requeue([id]);
			const second = store.drainUnread("gru");
			expect(second).toHaveLength(1);
			expect(second[0].id).toBe(id);
		});

		it("holds a drained-but-unconfirmed message out of the next drain until it goes stale", () => {
			// Within the staleness window a pending (in-flight) message is not
			// re-claimed, so a second drain in the same turn does not double-deliver.
			store.send("kevin", "gru", "in flight");
			expect(store.drainUnread("gru")).toHaveLength(1);
			expect(store.drainUnread("gru")).toHaveLength(0);
		});

		it("reclaims a message stuck pending past the staleness window", () => {
			// Zero staleness: a claimed-but-unconfirmed message is immediately
			// considered abandoned (crash-after-claim) and redelivered on next drain.
			const strict = new MessageStore(join(dir, "reclaim", "messages.db"), { stalenessMs: 0 });
			try {
				const id = strict.send("kevin", "gru", "orphaned");
				expect(strict.drainUnread("gru")).toHaveLength(1);
				// No confirm, no requeue — simulate a crash. Next drain recovers it.
				const recovered = strict.drainUnread("gru");
				expect(recovered).toHaveLength(1);
				expect(recovered[0].id).toBe(id);
			} finally {
				strict.close();
			}
		});

		it("markDelivered and requeue ignore ids that are not pending", () => {
			// Idempotent no-ops: confirming/requeuing an unknown or already-terminal
			// id must not throw or resurrect anything.
			store.send("kevin", "gru", "x");
			expect(() => store.markDelivered(["m:nonexistent"])).not.toThrow();
			expect(() => store.requeue(["m:nonexistent"])).not.toThrow();
			// The still-unread message is untouched.
			expect(store.unreadCount("gru")).toBe(1);
		});
	});

	it("shares state across separate store handles on the same file", () => {
		const dbPath = join(dir, "shared", "messages.db");
		const writer = new MessageStore(dbPath);
		const reader = new MessageStore(dbPath);
		try {
			writer.send("a", "b", "cross-process");
			const drained = reader.drainUnread("b");
			expect(drained).toHaveLength(1);
			expect(drained[0].content).toBe("cross-process");
		} finally {
			writer.close();
			reader.close();
		}
	});

	describe("presence", () => {
		// A pid that is essentially never a live process, used to model a crashed
		// or departed agent whose presence row was never cleaned up.
		const DEAD_PID = 2147483646;

		it("returns undefined for an agent that never recorded presence", () => {
			expect(store.getPresence("ghost")).toBeUndefined();
		});

		it("records and reads back an active agent (with a live pid) as online", () => {
			store.updatePresence("gru", "active", { pid: process.pid, bootId: "boot-1" });
			const p = store.getPresence("gru");
			expect(p?.state).toBe("active");
			expect(p?.online).toBe(true);
			expect(p?.pid).toBe(process.pid);
			expect(p?.bootId).toBe("boot-1");
			expect(p?.lastSeen).toBeTruthy();
		});

		it("reports an offline agent as not online and clears pid/boot_id", () => {
			store.updatePresence("gru", "active", { pid: process.pid, bootId: "boot-1" });
			store.updatePresence("gru", "offline");
			const p = store.getPresence("gru");
			expect(p?.state).toBe("offline");
			expect(p?.online).toBe(false);
			expect(p?.pid).toBeNull();
			expect(p?.bootId).toBeNull();
			expect(p?.lastSeen).toBeTruthy();
		});

		it("treats a dead pid as offline even when the recorded state is active", () => {
			// A crashed process leaves an `active` row whose pid no longer exists.
			// Probing the pid directly reports it offline immediately.
			store.updatePresence("gru", "active", { pid: DEAD_PID, bootId: "boot-dead" });
			const p = store.getPresence("gru");
			expect(p?.state).toBe("active");
			expect(p?.online).toBe(false);
		});

		it("treats a missing pid as offline", () => {
			// A state recorded without a pid can never be probed as alive.
			store.updatePresence("gru", "idle");
			const p = store.getPresence("gru");
			expect(p?.state).toBe("idle");
			expect(p?.online).toBe(false);
			expect(p?.pid).toBeNull();
		});

		it("enriches drained messages with the sender's presence", () => {
			store.updatePresence("kevin", "idle", { pid: process.pid, bootId: "boot-kevin" });
			store.send("kevin", "gru", "ping");
			const drained = store.drainUnread("gru");
			expect(drained).toHaveLength(1);
			expect(drained[0].senderPresence?.state).toBe("idle");
			expect(drained[0].senderPresence?.online).toBe(true);
		});

		it("leaves senderPresence undefined when the sender has no record", () => {
			store.send("unknown", "gru", "ping");
			const drained = store.drainUnread("gru");
			expect(drained[0].senderPresence).toBeUndefined();
		});
	});

	describe("isProcessAlive", () => {
		it("reports the current process as alive", () => {
			expect(MessageStore.isProcessAlive(process.pid)).toBe(true);
		});

		it("reports a departed pid as dead", () => {
			expect(MessageStore.isProcessAlive(2147483646)).toBe(false);
		});

		it("rejects invalid pids", () => {
			expect(MessageStore.isProcessAlive(0)).toBe(false);
			expect(MessageStore.isProcessAlive(-1)).toBe(false);
			expect(MessageStore.isProcessAlive(1.5)).toBe(false);
		});
	});

	describe("priority", () => {
		it("defaults to normal priority", () => {
			store.send("a", "b", "hello");
			const drained = store.drainUnread("b");
			expect(drained[0].priority).toBe("normal");
		});

		it("records urgent priority", () => {
			store.send("a", "b", "hello", "urgent");
			const drained = store.drainUnread("b");
			expect(drained[0].priority).toBe("urgent");
		});

		it("drains urgent messages before normal ones, FIFO within each priority", () => {
			store.send("a", "b", "normal-1", "normal");
			store.send("a", "b", "urgent-1", "urgent");
			store.send("a", "b", "normal-2", "normal");
			store.send("a", "b", "urgent-2", "urgent");
			const drained = store.drainUnread("b");
			expect(drained.map((m) => m.content)).toEqual(["urgent-1", "urgent-2", "normal-1", "normal-2"]);
		});
	});

	describe("drain cap", () => {
		it("claims at most `limit` messages, leaving the rest unread", () => {
			for (let i = 0; i < 5; i++) store.send("a", "b", `m${i}`, "normal");
			const first = store.drainUnread("b", 2);
			expect(first.map((m) => m.content)).toEqual(["m0", "m1"]);
			expect(store.unreadCount("b")).toBe(3);
		});

		it("delivers the whole backlog across successive capped drains, no loss or dup", () => {
			for (let i = 0; i < 5; i++) store.send("a", "b", `m${i}`, "normal");
			const seen: string[] = [];
			let batch = store.drainUnread("b", 2);
			while (batch.length > 0) {
				seen.push(...batch.map((m) => m.content));
				batch = store.drainUnread("b", 2);
			}
			expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
		});

		it("lets urgent messages take the cap ahead of older normal ones", () => {
			store.send("a", "b", "normal-old", "normal");
			store.send("a", "b", "normal-old2", "normal");
			store.send("a", "b", "urgent-new", "urgent");
			// cap=1: the urgent message wins the single slot despite being newest.
			const first = store.drainUnread("b", 1);
			expect(first.map((m) => m.content)).toEqual(["urgent-new"]);
			// Remaining drains preserve FIFO among the leftover normals.
			const rest = store.drainUnread("b");
			expect(rest.map((m) => m.content)).toEqual(["normal-old", "normal-old2"]);
		});

		it("treats a non-positive or omitted limit as unbounded", () => {
			for (let i = 0; i < 3; i++) store.send("a", "b", `m${i}`, "normal");
			expect(store.drainUnread("b", 0)).toHaveLength(3);
		});
	});
});
