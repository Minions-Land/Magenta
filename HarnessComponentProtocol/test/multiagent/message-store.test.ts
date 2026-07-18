import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FederatedMessageEnvelope, MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import { DatabaseSync } from "../../tools/send-message/magenta/sqlite-adapter.ts";

type DrainWorkerMessage = { type: "ready" } | { type: "result"; ids: string[]; contents: string[] };

function waitForWorkerMessage<T extends DrainWorkerMessage["type"]>(
	child: ChildProcess,
	type: T,
): Promise<Extract<DrainWorkerMessage, { type: T }>> {
	return new Promise((resolve, reject) => {
		const onMessage = (message: DrainWorkerMessage) => {
			if (message?.type !== type) return;
			cleanup();
			resolve(message as Extract<DrainWorkerMessage, { type: T }>);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(new Error(`drain worker exited before ${type} with code ${code}`));
		};
		const cleanup = () => {
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

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

		it("does not reclaim an old claim while its exact owner process is still active", () => {
			const strict = new MessageStore(join(dir, "live-claim", "messages.db"), { stalenessMs: 0 });
			try {
				strict.updatePresence("gru", "active", { pid: process.pid, bootId: "live-owner" });
				const id = strict.send("kevin", "gru", "long-running turn");
				expect(
					strict
						.drainUnread("gru", undefined, { ownerId: "live-owner", pid: process.pid })
						.map((message) => message.id),
				).toEqual([id]);
				// Even with a zero staleness window, a second drain must not duplicate
				// work that is still queued inside the live owner process.
				expect(strict.drainUnread("gru", undefined, { ownerId: "live-owner", pid: process.pid })).toHaveLength(0);
				strict.markDelivered([id], "live-owner");
				expect(strict.drainUnread("gru")).toHaveLength(0);
			} finally {
				strict.close();
			}
		});

		it("reclaims a dead owner's claim without letting the old owner settle the new claim", () => {
			const strict = new MessageStore(join(dir, "owner-handoff", "messages.db"), { stalenessMs: 0 });
			const deadPid = 2_147_483_646;
			try {
				strict.updatePresence("gru", "active", { pid: deadPid, bootId: "old-owner" });
				const id = strict.send("kevin", "gru", "handoff safely");
				expect(
					strict
						.drainUnread("gru", undefined, { ownerId: "old-owner", pid: deadPid })
						.map((message) => message.id),
				).toEqual([id]);

				strict.updatePresence("gru", "active", { pid: process.pid, bootId: "new-owner" });
				const recovered = strict.drainUnread("gru", undefined, { ownerId: "new-owner", pid: process.pid });
				expect(recovered.map((message) => message.id)).toEqual([id]);

				// A late callback from the old process cannot confirm or requeue rows
				// that the new owner has already claimed.
				strict.markDelivered([id], "old-owner");
				strict.requeue([id], "old-owner");
				expect(strict.drainUnread("gru", undefined, { ownerId: "new-owner", pid: process.pid })).toHaveLength(0);
				strict.markDelivered([id], "new-owner");
				expect(strict.drainUnread("gru")).toHaveLength(0);
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

	describe("federated routing", () => {
		it("persists a stable store id and supports a configured id for a new store", () => {
			const dbPath = join(dir, "identity", "messages.db");
			const first = new MessageStore(dbPath, { storeId: "store:ssh-a" });
			const second = new MessageStore(dbPath);
			try {
				expect(first.storeId).toBe("store:ssh-a");
				expect(first.getStoreId()).toBe("store:ssh-a");
				expect(second.storeId).toBe("store:ssh-a");
			} finally {
				first.close();
				second.close();
			}
		});

		it("migrates legacy messages and drains metadata from the new column", () => {
			const dbPath = join(dir, "migration", "messages.db");
			mkdirSync(join(dir, "migration"), { recursive: true });
			const raw = new DatabaseSync(dbPath);
			raw.exec(`
				CREATE TABLE messages (
				  id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
				  content TEXT NOT NULL, created_at TEXT NOT NULL,
				  status TEXT NOT NULL DEFAULT 'unread', priority TEXT NOT NULL DEFAULT 'normal'
				);
				INSERT INTO messages (id, sender, recipient, content, created_at, status, priority)
				VALUES ('m:legacy', 'old', 'local', 'before migration', '2026-01-01T00:00:00.000Z', 'unread', 'normal');
			`);
			raw.close();

			const migrated = new MessageStore(dbPath);
			try {
				const legacy = migrated.drainUnread("local");
				expect(legacy).toHaveLength(1);
				expect(legacy[0].id).toBe("m:legacy");
				expect(legacy[0].metadata).toBeUndefined();
				migrated.send("new", "local", "after migration", "urgent", {
					routeTag: "route-7",
					relayState: "completed",
					nested: { attempt: 2 },
				});
				expect(migrated.drainUnread("local")[0].metadata).toEqual({
					routeTag: "route-7",
					relayState: "completed",
					nested: { attempt: 2 },
				});
			} finally {
				migrated.close();
			}
		});

		it("routes presence-owned recipients locally and preserves metadata", () => {
			store.updatePresence("local-b", "offline");
			store.updatePresence("local-a", "active", { pid: process.pid, bootId: "local-a-boot" });
			const result = store.sendRouted("local-a", "local-b", "finish", "urgent", {
				routeTag: "route-local",
				relayState: "completed",
				custom: true,
			});
			expect(result).toMatchObject({
				id: expect.stringMatching(/^m:/),
				createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				disposition: "local",
			});
			expect(store.getPeerOutboxCounts()).toEqual({ pending: 0, inflight: 0, forwarded: 0, unresolved: 0 });
			const drained = store.drainUnread("local-b");
			expect(drained).toHaveLength(1);
			expect(drained[0]).toMatchObject({
				id: result.id,
				priority: "urgent",
				metadata: {
					routeTag: "route-local",
					relayState: "completed",
					custom: true,
				},
			});
			expect(store.listRegisteredSessionIds()).toEqual(["local-a", "local-b"]);
		});

		it("registers and replaces only one peer's advertised routes", () => {
			store.registerPeerRoute("remote-old", "store:peer-a");
			store.registerPeerRoute("remote-other", "store:peer-b");
			store.replacePeerRoutes("store:peer-a", ["remote-new", "remote-new"]);
			expect(store.listPeerRoutes().map(({ sessionId, peerStoreId }) => ({ sessionId, peerStoreId }))).toEqual([
				{ sessionId: "remote-new", peerStoreId: "store:peer-a" },
				{ sessionId: "remote-other", peerStoreId: "store:peer-b" },
			]);
			expect(store.listPeerRoutes("store:peer-a").map((route) => route.sessionId)).toEqual(["remote-new"]);
		});

		it("does not let peer advertisements hijack local or already-owned sessions", () => {
			store.updatePresence("local", "offline");
			store.replacePeerRoutes("store:peer-a", ["owned", "local"]);
			store.replacePeerRoutes("store:peer-b", ["owned", "local", "peer-b"]);
			expect(store.listPeerRoutes().map(({ sessionId, peerStoreId }) => ({ sessionId, peerStoreId }))).toEqual([
				{ sessionId: "owned", peerStoreId: "store:peer-a" },
				{ sessionId: "peer-b", peerStoreId: "store:peer-b" },
			]);
		});

		it("queues peer and unresolved sends, then resolves pending rows when a route arrives", () => {
			store.registerPeerRoute("known", "store:peer-a");
			const routed = store.sendRouted("sender", "known", "known target");
			const unresolved = store.sendRouted("sender", "later", "unknown target");
			expect(routed).toMatchObject({
				id: expect.stringMatching(/^m:/),
				createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				disposition: "peer",
				peerStoreId: "store:peer-a",
			});
			expect(unresolved).toMatchObject({
				id: expect.stringMatching(/^m:/),
				createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				disposition: "unresolved",
			});
			expect(store.getPeerOutboxCounts()).toEqual({ pending: 2, inflight: 0, forwarded: 0, unresolved: 1 });
			expect(store.claimPeerOutbox("store:peer-a", "bridge-a", 10).map((message) => message.id)).toEqual([
				routed.id,
			]);
			store.registerPeerRoute("later", "store:peer-b");
			const resolved = store.claimPeerOutbox("store:peer-b", "bridge-b", 10);
			expect(resolved.map((message) => ({ id: message.id, target: message.targetPeerStoreId }))).toEqual([
				{ id: unresolved.id, target: "store:peer-b" },
			]);
		});

		it("lets one peer claim unresolved rows when discovery forwarding is enabled", () => {
			const sent = store.sendRouted("sender", "unknown", "discover me");
			expect(store.claimPeerOutbox("store:peer-a", "bridge-a", 10)).toHaveLength(0);
			const claimed = store.claimPeerOutbox("store:peer-a", "bridge-a", 10, true);
			expect(claimed).toHaveLength(1);
			expect(claimed[0]).toMatchObject({ id: sent.id, targetPeerStoreId: null, status: "inflight" });
			// A route learned while the unresolved row is in flight is applied when
			// the failed discovery attempt is requeued.
			store.registerPeerRoute("unknown", "store:peer-b");
			expect(store.requeuePeerOutbox([sent.id], "bridge-a")).toBe(1);
			expect(store.claimPeerOutbox("store:peer-b", "bridge-b", 10)[0].targetPeerStoreId).toBe("store:peer-b");
		});

		it("claims disjoint outbox batches across independent store handles", () => {
			const dbPath = join(dir, "federated-shared", "messages.db");
			const first = new MessageStore(dbPath);
			const second = new MessageStore(dbPath);
			try {
				first.registerPeerRoute("remote", "store:peer-a");
				const ids = Array.from(
					{ length: 6 },
					(_, index) => first.sendRouted("sender", "remote", `peer-${index}`).id,
				);
				const firstClaim = first.claimPeerOutbox("store:peer-a", "bridge-1", 3);
				const secondClaim = second.claimPeerOutbox("store:peer-a", "bridge-2", 3);
				const claimedIds = [...firstClaim, ...secondClaim].map((message) => message.id);
				expect(firstClaim).toHaveLength(3);
				expect(secondClaim).toHaveLength(3);
				expect(new Set(claimedIds).size).toBe(6);
				expect(claimedIds.slice().sort()).toEqual(ids.slice().sort());
			} finally {
				first.close();
				second.close();
			}
		});

		it("enforces outbox claim ownership for requeue and ack", () => {
			store.registerPeerRoute("remote", "store:peer-a");
			const sent = store.sendRouted("sender", "remote", "owned", "urgent", {
				routeTag: "route-peer",
			});
			const first = store.claimPeerOutbox("store:peer-a", "owner-1", 1);
			expect(first).toHaveLength(1);
			expect(first[0]).toMatchObject({
				id: sent.id,
				status: "inflight",
				claimOwner: "owner-1",
				metadata: { routeTag: "route-peer" },
			});
			expect(store.claimPeerOutbox("store:peer-a", "owner-2", 1)).toHaveLength(0);
			expect(store.requeuePeerOutbox([sent.id], "owner-2")).toBe(0);
			expect(store.requeuePeerOutbox([sent.id], "owner-1")).toBe(1);
			const second = store.claimPeerOutbox("store:peer-a", "owner-2", 1);
			expect(second.map((message) => message.id)).toEqual([sent.id]);
			expect(store.ackPeerOutbox([sent.id], "owner-1")).toBe(0);
			expect(store.ackPeerOutbox([sent.id], "owner-2")).toBe(1);
			expect(store.getPeerOutboxCounts()).toEqual({ pending: 0, inflight: 0, forwarded: 1, unresolved: 0 });
		});

		it("reclaims stale inflight rows after a relay hard crash", () => {
			const crashStore = new MessageStore(join(dir, "crash-reclaim", "messages.db"), {
				peerOutboxClaimTimeoutMs: 0,
			});
			try {
				crashStore.registerPeerRoute("remote", "store:peer-a");
				const sent = crashStore.sendRouted("sender", "remote", "survive relay crash");
				expect(crashStore.claimPeerOutbox("store:peer-a", "dead-relay", 1)[0]?.id).toBe(sent.id);
				const reclaimed = crashStore.claimPeerOutbox("store:peer-a", "replacement-relay", 1);
				expect(reclaimed).toHaveLength(1);
				expect(reclaimed[0]).toMatchObject({ id: sent.id, claimOwner: "replacement-relay" });
			} finally {
				crashStore.close();
			}
		});

		it("backs off not-found rows without starving newer eligible messages", () => {
			store.registerPeerRoute("missing", "store:stale-peer");
			const stale = store.sendRouted("sender", "missing", "stale route");
			expect(store.claimPeerOutbox("store:stale-peer", "relay-1", 1)[0]?.id).toBe(stale.id);
			expect(store.requeuePeerOutbox([stale.id], "relay-1", { notFound: true })).toBe(1);
			expect(store.listPeerRoutes()).toHaveLength(0);

			const newer = store.sendRouted("sender", "other-missing", "eligible discovery");
			const eligible = store.claimPeerOutbox("store:hub", "relay-2", 1, true);
			expect(eligible.map((message) => message.id)).toEqual([newer.id]);

			store.registerPeerRoute("missing", "store:new-peer");
			const rerouted = store.claimPeerOutbox("store:new-peer", "relay-3", 1);
			expect(rerouted).toHaveLength(1);
			expect(rerouted[0]).toMatchObject({ id: stale.id, attemptCount: 0, targetPeerStoreId: "store:new-peer" });
		});

		it("moves a claimed envelope between stores without changing id or metadata", () => {
			const remote = new MessageStore(join(dir, "remote-store", "messages.db"));
			try {
				remote.updatePresence("remote-recipient", "offline");
				store.registerPeerRoute("remote-recipient", remote.storeId);
				const sent = store.sendRouted("local-sender", "remote-recipient", "cross store", "urgent", {
					routeTag: "route-cross-store",
				});
				const [claimed] = store.claimPeerOutbox(remote.storeId, "ssh-bridge", 1);
				expect(remote.acceptFederatedMessage(claimed, store.storeId)).toEqual({
					id: sent.id,
					disposition: "local",
				});
				expect(remote.drainUnread("remote-recipient")[0]).toMatchObject({
					id: sent.id,
					metadata: { routeTag: "route-cross-store" },
				});
			} finally {
				remote.close();
			}
		});

		it("accepts a local federated envelope once while preserving its source id", () => {
			store.updatePresence("recipient", "idle", { pid: process.pid, bootId: "recipient-boot" });
			const envelope: FederatedMessageEnvelope = {
				id: "m:from-peer",
				sender: "remote-sender",
				recipient: "recipient",
				content: "over ssh",
				createdAt: "2026-07-16T00:00:00.000Z",
				priority: "normal",
				metadata: { routeTag: "route-remote", relayState: "failed" },
			};
			expect(store.acceptFederatedMessage(envelope, "store:ingress")).toEqual({
				id: envelope.id,
				disposition: "local",
			});
			expect(store.acceptFederatedMessage(envelope, "store:ingress")).toEqual({
				id: envelope.id,
				disposition: "duplicate",
			});
			const drained = store.drainUnread("recipient");
			expect(drained).toHaveLength(1);
			expect(drained[0]).toMatchObject({ id: envelope.id, metadata: envelope.metadata });
		});

		it("durably relays to a different peer and rejects unknown or ingress-loop routes", () => {
			store.registerPeerRoute("beyond", "store:egress");
			store.registerPeerRoute("back", "store:ingress");
			const relay: FederatedMessageEnvelope = {
				id: "m:relay",
				sender: "source",
				recipient: "beyond",
				content: "two hops",
				createdAt: "2026-07-16T00:00:00.000Z",
				priority: "urgent",
				metadata: { hop: 1 },
			};
			expect(store.acceptFederatedMessage(relay, "store:ingress")).toEqual({
				id: relay.id,
				disposition: "relay",
				peerStoreId: "store:egress",
			});
			const claimed = store.claimPeerOutbox("store:egress", "relay-owner", 10);
			expect(claimed).toHaveLength(1);
			expect(claimed[0]).toMatchObject({ ...relay, targetPeerStoreId: "store:egress" });

			const loop = { ...relay, id: "m:loop", recipient: "back" };
			const missing = { ...relay, id: "m:missing", recipient: "missing" };
			expect(store.acceptFederatedMessage(loop, "store:ingress").disposition).toBe("not_found");
			expect(store.acceptFederatedMessage(missing, "store:ingress").disposition).toBe("not_found");
		});
	});

	describe("peer endpoint relay state", () => {
		it("persists manual desired state while refreshing endpoint configuration", () => {
			expect(store.upsertPeerEndpoint("hub", "root@example", 23915)).toMatchObject({
				id: "hub",
				remote: "root@example",
				port: 23915,
				desiredState: "on",
				observedState: "closed",
			});
			expect(store.setPeerEndpointDesiredState("hub", "off")).toBe(true);
			store.upsertPeerEndpoint("hub", "root@renamed", 23915);
			expect(store.getPeerEndpoint("hub")).toMatchObject({
				remote: "root@renamed",
				desiredState: "off",
			});
		});

		it("fences relay ownership and suppresses claims while manually off", () => {
			store.upsertPeerEndpoint("hub", "root@example");
			expect(store.claimPeerEndpointRelay("hub", process.pid, "relay-a")).toBe(true);
			expect(store.claimPeerEndpointRelay("hub", process.pid, "relay-b")).toBe(false);
			expect(store.updatePeerEndpointRelay("hub", "relay-a", "connected", { remoteStoreId: "store:hub" })).toBe(
				true,
			);
			expect(store.getPeerEndpoint("hub")).toMatchObject({
				observedState: "connected",
				remoteStoreId: "store:hub",
				relayPid: process.pid,
				relayBootId: "relay-a",
			});
			expect(store.releasePeerEndpointRelay("hub", "relay-b")).toBe(false);
			expect(store.releasePeerEndpointRelay("hub", "relay-a")).toBe(true);
			expect(store.setPeerEndpointDesiredState("hub", "off")).toBe(true);
			expect(store.claimPeerEndpointRelay("hub", process.pid, "relay-c")).toBe(false);
		});

		it("lists unique live Magenta pids from presence", () => {
			store.updatePresence("one", "idle", { pid: process.pid, bootId: "one" });
			store.updatePresence("two", "active", { pid: process.pid, bootId: "two" });
			store.updatePresence("dead", "active", { pid: 2_147_483_646, bootId: "dead" });
			expect(store.listLiveSessionPids()).toEqual([process.pid]);
		});
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

		it("claims disjoint full batches across independent database connections", () => {
			for (let i = 0; i < 6; i++) store.send("a", "b", `m${i}`, "normal");
			const secondStore = new MessageStore(join(dir, "sub", "messages.db"));
			try {
				const first = store.drainUnread("b", 3);
				const second = secondStore.drainUnread("b", 3);
				expect(first.map((message) => message.content)).toEqual(["m0", "m1", "m2"]);
				expect(second.map((message) => message.content)).toEqual(["m3", "m4", "m5"]);
				expect(new Set([...first, ...second].map((message) => message.id)).size).toBe(6);
			} finally {
				secondStore.close();
			}
		});

		it("claims disjoint batches when separate processes drain simultaneously", async () => {
			const dbPath = join(dir, "sub", "messages.db");
			for (let i = 0; i < 20; i++) store.send("a", "b", `m${i}`, "normal");
			const workerPath = fileURLToPath(new URL("./message-store-drain-worker.ts", import.meta.url));
			const workers = [
				fork(workerPath, [dbPath, "b", "10"], {
					execArgv: ["--import", "tsx"],
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				}),
				fork(workerPath, [dbPath, "b", "10"], {
					execArgv: ["--import", "tsx"],
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				}),
			];
			try {
				const ready = workers.map((worker) => waitForWorkerMessage(worker, "ready"));
				await Promise.all(ready);
				const results = workers.map((worker) => waitForWorkerMessage(worker, "result"));
				for (const worker of workers) worker.send("go");
				const drained = await Promise.all(results);
				const ids = drained.flatMap((result) => result.ids);
				const contents = drained.flatMap((result) => result.contents);
				expect(drained.map((result) => result.ids)).toEqual([expect.any(Array), expect.any(Array)]);
				expect(drained.every((result) => result.ids.length === 10)).toBe(true);
				expect(new Set(ids).size).toBe(20);
				expect(contents.slice().sort()).toEqual(Array.from({ length: 20 }, (_, index) => `m${index}`).sort());
				expect(store.unreadCount("b")).toBe(0);
			} finally {
				for (const worker of workers) {
					if (!worker.killed) worker.kill();
				}
			}
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

		it("floors a fractional cap and treats a non-finite cap as unbounded", () => {
			for (let i = 0; i < 3; i++) store.send("a", "b", `m${i}`, "normal");
			const first = store.drainUnread("b", 1.9);
			expect(first.map((message) => message.content)).toEqual(["m0"]);
			store.markDelivered(first.map((message) => message.id));
			expect(store.drainUnread("b", Number.POSITIVE_INFINITY).map((message) => message.content)).toEqual([
				"m1",
				"m2",
			]);
		});
	});
});
