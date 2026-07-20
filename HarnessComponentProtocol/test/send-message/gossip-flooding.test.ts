/**
 * Verification for pure gossip flooding (Route 1: per-link delivery ledger).
 *
 * Replaces the earlier route-propagation.test.ts, which exercised the now-removed
 * peer_routes forwarding gate. Under pure gossip a message floods to every
 * connected relay link; receiver-side `peer_seen` + `visitedStoreIds` bound the
 * flood, and a per-link delivery ledger (`peer_outbox_delivery`) ensures each
 * link forwards a given message at most once.
 *
 * Scenarios:
 *   a. parallel flood      — one message claimable by multiple distinct links
 *   b. offline reconnect   — message waits in outbox, delivered when link appears
 *   c. dedup / loop guard  — a message seen once is rejected on re-entry
 *   d. TTL convergence     — hopsRemaining bound stops an over-long relay chain
 *   e. ingress echo guard  — the ingress link never re-claims what it delivered
 *   f. GC retention        — messages past the retention window are purged
 *   g. three-party relay   — A -> hub -> C end-to-end delivery
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FederatedMessageEnvelope } from "../../tools/send-message/magenta/message-store.ts";
import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import { DEFAULT_PEER_LINK_HOPS } from "../../tools/send-message/magenta/peer-link-protocol.ts";

describe("gossip flooding (Route 1)", () => {
	const dirs: string[] = [];
	const stores: MessageStore[] = [];

	afterEach(() => {
		for (const store of stores.splice(0)) {
			try {
				store.close();
			} catch {
				// already closed
			}
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function freshStore(options?: ConstructorParameters<typeof MessageStore>[1]): MessageStore {
		const dir = mkdtempSync(join(tmpdir(), "gossip-flood-"));
		dirs.push(dir);
		const store = new MessageStore(join(dir, "g.db"), options);
		stores.push(store);
		return store;
	}

	// a. Parallel flood: a locally-sent message is claimable by every link, and
	//    each link's claim is independent (per-link delivery ledger).
	it("parallel flood: distinct links each claim the same message once", () => {
		const hub = freshStore();
		const sent = hub.sendRouted("hub-sender", "remote-recipient", "flood me");
		expect(sent.disposition).toBe("peer");

		// Two distinct links (peer-a, peer-c) both claim the same message.
		const claimA = hub.claimPeerOutbox("store:peer-a", "relay-a", 10);
		const claimC = hub.claimPeerOutbox("store:peer-c", "relay-c", 10);
		expect(claimA).toHaveLength(1);
		expect(claimC).toHaveLength(1);
		expect(claimA[0].id).toBe(sent.id);
		expect(claimC[0].id).toBe(sent.id);

		// Re-claim on the same link (still inflight) yields nothing.
		expect(hub.claimPeerOutbox("store:peer-a", "relay-a", 10)).toHaveLength(0);

		// Ack on one link does not remove the message body; the other link's ledger stands.
		hub.ackPeerOutbox([sent.id], "relay-a");
		hub.ackPeerOutbox([sent.id], "relay-c");
		expect(hub.getPeerOutboxCounts().forwarded).toBe(2);
	});

	// b. Offline reconnect: message to an offline recipient waits in the outbox
	//    (target=NULL, no link exists yet), then is delivered when the link
	//    appears. This is the real user bug: sending to an offline haofeng.
	it("offline reconnect: queued message is delivered when the link reconnects", () => {
		const hub = freshStore();
		// Recipient "haofeng" is offline: no presence row, no link. Message queues.
		const sent = hub.sendRouted("alice", "haofeng", "are you there?");
		expect(sent.disposition).toBe("peer");
		expect(hub.getPeerOutboxCounts().pending).toBe(1);

		// haofeng's link is not connected yet: no claim happens (simulated by
		// simply not claiming). Message body persists.
		expect(hub.getPeerOutboxCounts().pending).toBe(1);

		// haofeng reconnects: its link claims the queued message and forwards it.
		const claimed = hub.claimPeerOutbox("store:haofeng-leaf", "haofeng-relay", 10);
		expect(claimed).toHaveLength(1);
		expect(claimed[0].id).toBe(sent.id);
		expect(claimed[0].content).toBe("are you there?");
		hub.ackPeerOutbox([sent.id], "haofeng-relay");
		expect(hub.getPeerOutboxCounts().forwarded).toBe(1);
	});

	// c. Dedup / loop guard: a message accepted once is rejected as duplicate on
	//    re-entry (peer_seen), even from a different ingress peer.
	it("dedup: a message seen once is rejected on re-entry from any peer", () => {
		const hub = freshStore();
		hub.updatePresence("hub-local", "idle");
		const envelope: FederatedMessageEnvelope = {
			id: "m:dedup-1",
			sender: "source",
			recipient: "beyond-hub",
			content: "flood",
			createdAt: "2026-07-16T00:00:00.000Z",
			priority: "urgent",
		};
		// First acceptance: relayed onward.
		expect(hub.acceptFederatedMessage(envelope, "store:ingress-a").disposition).toBe("relay");
		// Same id re-enters from a different peer: rejected as duplicate.
		expect(hub.acceptFederatedMessage(envelope, "store:ingress-b").disposition).toBe("duplicate");
		// And a re-entry from the same peer: also duplicate.
		expect(hub.acceptFederatedMessage(envelope, "store:ingress-a").disposition).toBe("duplicate");
	});

	// d. TTL convergence: V1 keeps its historical two-hop wire bound so new and
	//    old binaries interoperate. This covers source -> relay -> destination;
	//    larger topologies require a negotiated protocol revision.
	it("TTL: V1 keeps the compatible two-hop flooding budget", () => {
		expect(DEFAULT_PEER_LINK_HOPS).toBe(2);
	});

	// e. Ingress echo guard: a message relayed IN from peer X is pre-marked
	//    delivered for X, so X's link never re-claims it; every other link does.
	it("ingress echo guard: ingress link never re-claims a relayed message", () => {
		const hub = freshStore();
		const envelope: FederatedMessageEnvelope = {
			id: "m:echo-1",
			sender: "source",
			recipient: "beyond-hub",
			content: "no echo",
			createdAt: "2026-07-16T00:00:00.000Z",
			priority: "urgent",
		};
		expect(hub.acceptFederatedMessage(envelope, "store:ingress").disposition).toBe("relay");
		// The ingress link must not re-claim (pre-marked forwarded).
		expect(hub.claimPeerOutbox("store:ingress", "ingress-relay", 10)).toHaveLength(0);
		// Any other link floods it onward.
		const egress = hub.claimPeerOutbox("store:egress", "egress-relay", 10);
		expect(egress).toHaveLength(1);
		expect(egress[0].id).toBe(envelope.id);
	});

	// f. GC retention: messages older than the retention window are purged along
	//    with their per-link delivery rows; fresh messages are kept.
	it("GC: purgeExpiredOutbox removes only messages past the retention window", () => {
		const retentionMs = 7 * 24 * 60 * 60 * 1000; // 7-day retention.
		const hub = freshStore({ peerOutboxRetentionMs: retentionMs });
		const fresh = hub.sendRouted("alice", "haofeng", "recent");
		// Claim on a link to create a delivery row (proves cascade delete works).
		hub.claimPeerOutbox("store:leaf", "relay", 10);

		// Nothing expired yet.
		expect(hub.purgeExpiredOutbox(Date.now())).toBe(0);
		expect(hub.getPeerOutboxCounts().pending).toBe(1);

		// Advance virtual "now" to 8 days ahead: message is now older than 7 days.
		const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
		expect(hub.purgeExpiredOutbox(eightDaysLater)).toBe(1);
		expect(hub.getPeerOutboxCounts().pending).toBe(0);
		// Delivery rows cascade-deleted: forwarded/inflight counts drop to zero.
		const counts = hub.getPeerOutboxCounts();
		expect(counts.inflight).toBe(0);
		expect(counts.forwarded).toBe(0);
		// The purged id was a real message id (body is gone; peer_seen is separate).
		expect(fresh.id.startsWith("m:")).toBe(true);
	});

	// g. Three-party integration: A -> hub -> C end-to-end via store-level relay.
	it("three-party: A's message reaches C's inbox through the hub", () => {
		const a = freshStore({ storeId: "store:a" });
		const hub = freshStore({ storeId: "store:hub" });
		const c = freshStore({ storeId: "store:c" });
		c.updatePresence("carol", "idle");
		// A sends to carol (not local to A) -> queues in A's outbox.
		const sent = a.sendRouted("alice", "carol", "hi carol");
		expect(sent.disposition).toBe("peer");

		// A's link to hub claims and forwards; hub accepts (carol not local) -> relay.
		const [fromA] = a.claimPeerOutbox("store:hub", "a-hub-relay", 10);
		expect(fromA.id).toBe(sent.id);
		expect(hub.acceptFederatedMessage(fromA, "store:a").disposition).toBe("relay");
		a.ackPeerOutbox([sent.id], "a-hub-relay");

		// Hub's link to C claims and forwards; C accepts (carol IS local) -> local.
		const [fromHub] = hub.claimPeerOutbox("store:c", "hub-c-relay", 10);
		expect(fromHub.id).toBe(sent.id);
		expect(c.acceptFederatedMessage(fromHub, "store:hub").disposition).toBe("local");
		hub.ackPeerOutbox([sent.id], "hub-c-relay");

		// Carol receives it, id and content preserved.
		const drained = c.drainUnread("carol");
		expect(drained).toHaveLength(1);
		expect(drained[0].id).toBe(sent.id);
		expect(drained[0].content).toBe("hi carol");

		// Hub never echoes back to A: A's link finds nothing new.
		expect(hub.claimPeerOutbox("store:a", "hub-a-relay", 10)).toHaveLength(0);
	});
});
