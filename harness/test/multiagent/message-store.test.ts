import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore } from "../../modules/multiagent/message/message-store.ts";

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
		it("returns undefined for an agent that never recorded presence", () => {
			expect(store.getPresence("ghost")).toBeUndefined();
		});

		it("records and reads back an active agent as online", () => {
			store.updatePresence("gru", "active");
			const p = store.getPresence("gru");
			expect(p?.state).toBe("active");
			expect(p?.online).toBe(true);
			expect(p?.lastSeen).toBeTruthy();
		});

		it("reports an offline agent as not online but keeps last_seen", () => {
			store.updatePresence("gru", "active");
			store.updatePresence("gru", "offline");
			const p = store.getPresence("gru");
			expect(p?.state).toBe("offline");
			expect(p?.online).toBe(false);
			expect(p?.lastSeen).toBeTruthy();
		});

		it("treats a stale heartbeat as offline even when state is active", () => {
			// Zero staleness window: any recorded heartbeat is immediately stale,
			// modelling a crashed process that never got to mark itself offline.
			const strict = new MessageStore(join(dir, "strict", "messages.db"), { stalenessMs: 0 });
			try {
				strict.updatePresence("gru", "active");
				const p = strict.getPresence("gru");
				expect(p?.state).toBe("active");
				expect(p?.online).toBe(false);
			} finally {
				strict.close();
			}
		});

		it("enriches drained messages with the sender's presence", () => {
			store.updatePresence("kevin", "idle");
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
});
