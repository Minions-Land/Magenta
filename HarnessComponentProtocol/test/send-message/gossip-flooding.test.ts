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
 *   f. GC retention        — outbox and bounded dedup state expire safely
 *   g. three-party relay   — A -> hub -> C end-to-end delivery
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FederatedMessageEnvelope } from "../../tools/send-message/magenta/message-store.ts";
import { MessageStore, PEER_FEDERATION_METADATA_KEY } from "../../tools/send-message/magenta/message-store.ts";
import { DEFAULT_PEER_LINK_HOPS } from "../../tools/send-message/magenta/peer-link-protocol.ts";
import { DatabaseSync } from "../../tools/send-message/magenta/sqlite-adapter.ts";

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
		hub.ackPeerOutbox([sent.id], "relay-a", { durableCustody: true });
		hub.ackPeerOutbox([sent.id], "relay-c", { durableCustody: true });
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
		hub.ackPeerOutbox([sent.id], "haofeng-relay", { durableCustody: true });
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
		expect(
			hub.claimPeerOutbox("store:ingress", "ingress-relay", 10, false, {
				allowTransit: true,
				reclaimUnsettledForwarded: true,
			}),
		).toHaveLength(0);
		// Any other link floods it onward.
		const egress = hub.claimPeerOutbox("store:egress", "egress-relay", 10, false, { allowTransit: true });
		expect(egress).toHaveLength(1);
		expect(egress[0].id).toBe(envelope.id);
	});

	it("custody upgrade retries old forwarded rows once without reviving ingress echoes or not_found", () => {
		const hub = freshStore({ peerOutboxRetentionMs: 1_000 });
		const local = hub.sendRouted("alice", "remote", "held until durable");
		expect(hub.claimPeerOutbox("store:old", "old-owner", 10).map((message) => message.id)).toEqual([local.id]);
		expect(hub.ackPeerOutbox([local.id], "old-owner", { durableCustody: false })).toBe(1);

		const probe = new DatabaseSync(join(dirs.at(-1)!, "g.db"));
		try {
			expect(probe.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`).get(local.id)).toEqual({
				settled_at: null,
			});
			expect(hub.purgeExpiredOutbox(Date.now() + 30 * 24 * 60 * 60 * 1_000)).toBe(0);
			expect(hub.claimPeerOutbox("store:old", "ordinary-owner", 10)).toHaveLength(0);

			const recovered = hub.claimPeerOutbox("store:old", "durable-owner", 10, false, {
				allowTransit: true,
				reclaimUnsettledForwarded: true,
			});
			expect(recovered.map((message) => message.id)).toEqual([local.id]);
			expect(hub.requeuePeerOutbox([local.id], "durable-owner", { notFound: true })).toBe(1);
			expect(
				probe
					.prepare(`SELECT status, claim_owner, claimed_at FROM peer_outbox_delivery WHERE message_id = ?`)
					.get(local.id),
			).toEqual({ status: "rejected", claim_owner: null, claimed_at: null });
			expect(
				hub.claimPeerOutbox("store:old", "no-hot-loop", 10, false, {
					allowTransit: true,
					reclaimUnsettledForwarded: true,
				}),
			).toHaveLength(0);

			const relayHub = freshStore();
			const relayProbe = new DatabaseSync(join(dirs.at(-1)!, "g.db"));
			const transit: FederatedMessageEnvelope = {
				id: "m:old-egress-forwarded",
				sender: "origin",
				recipient: "beyond-hub",
				content: "recover egress only",
				createdAt: "2026-07-21T00:00:00.000Z",
				priority: "normal",
				metadata: {
					[PEER_FEDERATION_METADATA_KEY]: {
						originStoreId: "store:origin",
						visitedStoreIds: ["store:origin", "store:ingress"],
						hopsRemaining: 1,
					},
				},
			};
			try {
				expect(relayHub.acceptFederatedMessage(transit, "store:ingress").disposition).toBe("relay");
				expect(
					relayHub.claimPeerOutbox("store:ingress", "echo-owner", 10, false, {
						allowTransit: true,
						reclaimUnsettledForwarded: true,
					}),
				).toHaveLength(0);
				expect(
					relayHub
						.claimPeerOutbox("store:egress", "old-egress", 10, false, { allowTransit: true })
						.map((message) => message.id),
				).toEqual([transit.id]);
				relayHub.ackPeerOutbox([transit.id], "old-egress", { durableCustody: false });
				expect(
					relayHub
						.claimPeerOutbox("store:egress", "new-egress", 10, false, {
							allowTransit: true,
							reclaimUnsettledForwarded: true,
						})
						.map((message) => message.id),
				).toEqual([transit.id]);
				expect(relayHub.ackPeerOutbox([transit.id], "new-egress", { durableCustody: true })).toBe(1);
				const settled = relayProbe
					.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`)
					.get(transit.id) as { settled_at: string };
				expect(settled.settled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			} finally {
				relayProbe.close();
			}
		} finally {
			probe.close();
		}
	});

	it("reaccepts a seen-only payload atomically and rejects conflicting duplicate ids", () => {
		const hub = freshStore();
		const first: FederatedMessageEnvelope = {
			id: "m:seen-only-v029",
			sender: "source",
			recipient: "offline-target",
			content: "restore the body",
			createdAt: "2026-07-10T00:00:00.000Z",
			priority: "urgent",
			metadata: {
				routeTag: "stable",
				[PEER_FEDERATION_METADATA_KEY]: {
					originStoreId: "store:source",
					visitedStoreIds: ["store:source", "store:first-path"],
					hopsRemaining: 1,
				},
			},
		};
		expect(hub.acceptFederatedMessage(first, "store:first-path").disposition).toBe("relay");

		const probe = new DatabaseSync(join(dirs.at(-1)!, "g.db"));
		try {
			// Model the v0.0.29 7-day outbox purge, which predated the protection trigger.
			probe.exec(`DROP TRIGGER protect_unsettled_peer_outbox`);
			probe.prepare(`DELETE FROM peer_outbox_delivery WHERE message_id = ?`).run(first.id);
			probe.prepare(`DELETE FROM peer_outbox WHERE message_id = ?`).run(first.id);
			expect(probe.prepare(`SELECT 1 AS found FROM peer_seen WHERE message_id = ?`).get(first.id)).toEqual({
				found: 1,
			});

			const alternatePath: FederatedMessageEnvelope = {
				...first,
				metadata: {
					routeTag: "stable",
					[PEER_FEDERATION_METADATA_KEY]: {
						originStoreId: "store:source",
						visitedStoreIds: ["store:source", "store:second-path"],
						hopsRemaining: 1,
					},
				},
			};
			expect(hub.acceptFederatedMessage(alternatePath, "store:second-path").disposition).toBe("relay");
			probe
				.prepare(
					`INSERT INTO messages
					 (id, sender, recipient, content, created_at, status, priority, metadata_json)
					 VALUES (?, ?, ?, ?, ?, 'unread', ?, NULL)`,
				)
				.run(first.id, first.sender, first.recipient, "conflicting durable copy", first.createdAt, first.priority);
			expect(hub.acceptFederatedMessage(first, "store:first-path").disposition).toBe("not_found");
			probe.prepare(`DELETE FROM messages WHERE id = ?`).run(first.id);
			expect(hub.acceptFederatedMessage(first, "store:first-path").disposition).toBe("duplicate");
			expect(
				hub.acceptFederatedMessage({ ...alternatePath, content: "conflicting body" }, "store:attacker").disposition,
			).toBe("not_found");
			expect(probe.prepare(`SELECT COUNT(*) AS count FROM peer_seen WHERE message_id = ?`).get(first.id)).toEqual({
				count: 1,
			});
			expect(probe.prepare(`SELECT content FROM peer_outbox WHERE message_id = ?`).get(first.id)).toEqual({
				content: first.content,
			});
		} finally {
			probe.close();
		}
	});

	// f. GC retention starts only after a successful custody-transfer ACK.
	it("GC: retains old unacknowledged payloads and expires from settled_at", () => {
		const retentionMs = 7 * 24 * 60 * 60 * 1000; // 7-day retention.
		const hub = freshStore({ peerOutboxRetentionMs: retentionMs });
		const fresh = hub.sendRouted("alice", "haofeng", "recent");
		// Claim on a link to create a delivery row (proves cascade delete works).
		hub.claimPeerOutbox("store:leaf", "relay", 10);
		const probe = new DatabaseSync(join(dirs.at(-1)!, "g.db"));

		try {
			const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
			expect(hub.purgeExpiredOutbox(eightDaysLater)).toBe(0);
			const oldDelete = probe
				.prepare(`DELETE FROM peer_outbox WHERE received_at <= ?`)
				.run(new Date(eightDaysLater).toISOString()) as { changes: number | bigint };
			expect(Number(oldDelete.changes)).toBe(0);
			expect(hub.getPeerOutboxCounts().pending).toBe(1);

			expect(hub.ackPeerOutbox([fresh.id], "relay", { durableCustody: true })).toBe(1);
			const settled = probe.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`).get(fresh.id) as {
				settled_at: string;
			};
			expect(settled.settled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(hub.purgeExpiredOutbox(Date.parse(settled.settled_at) + retentionMs - 1)).toBe(0);
			expect(hub.purgeExpiredOutbox(Date.parse(settled.settled_at) + retentionMs)).toBe(1);
			expect(hub.getPeerOutboxCounts().pending).toBe(0);
			// Delivery rows are removed in the same transaction as the payload.
			const counts = hub.getPeerOutboxCounts();
			expect(counts.inflight).toBe(0);
			expect(counts.forwarded).toBe(0);
		} finally {
			probe.close();
		}
	});

	it("GC: not_found stops one link without marking the payload settled", () => {
		const hub = freshStore({ peerOutboxRetentionMs: 1_000 });
		const routed = hub.sendRouted("alice", "unknown", "keep searching");
		expect(hub.claimPeerOutbox("store:first", "first-owner", 10).map((message) => message.id)).toEqual([routed.id]);
		expect(hub.requeuePeerOutbox([routed.id], "first-owner", { notFound: true })).toBe(1);

		const probe = new DatabaseSync(join(dirs.at(-1)!, "g.db"));
		try {
			expect(probe.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`).get(routed.id)).toEqual({
				settled_at: null,
			});
			expect(hub.purgeExpiredOutbox(Date.now() + 30 * 24 * 60 * 60 * 1000)).toBe(0);
			expect(hub.claimPeerOutbox("store:first", "same-link", 10)).toHaveLength(0);
			expect(hub.claimPeerOutbox("store:second", "next-link", 10).map((message) => message.id)).toEqual([routed.id]);
		} finally {
			probe.close();
		}
	});

	it("GC: delivered inbox rows expire while unread and pending delivery remain durable", () => {
		const retentionMs = 1_000;
		const hub = freshStore({ readMessageRetentionMs: retentionMs });
		const probe = new DatabaseSync(join(dirs.at(-1)!, "g.db"));
		hub.updatePresence("read-recipient", "idle");
		hub.updatePresence("unread-recipient", "idle");
		hub.updatePresence("pending-recipient", "idle");

		const readId = hub.send("alice", "read-recipient", "delivered");
		const queuedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		probe.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(queuedAt, readId);
		const [read] = hub.drainUnread("read-recipient");
		expect(read.id).toBe(readId);
		hub.markDelivered([readId]);
		const delivered = probe.prepare(`SELECT created_at, read_at FROM messages WHERE id = ?`).get(readId) as {
			created_at: string;
			read_at: string;
		};
		expect(delivered.created_at).toBe(queuedAt);
		expect(delivered.read_at).not.toBe(queuedAt);
		hub.send("alice", "unread-recipient", "keep unread");
		const pendingId = hub.send("alice", "pending-recipient", "keep pending");
		expect(hub.drainUnread("pending-recipient")[0]?.id).toBe(pendingId);

		expect(hub.purgeExpiredReadMessages(Date.now())).toBe(0);
		// A local-only store has no PeerLinkSession timer. Its next operation window
		// still runs the same bounded maintenance without any idle wakeup.
		hub.maybeRunMaintenance(Date.now() + 2 * 60 * 60 * 1000);
		expect(hub.unreadCount("unread-recipient")).toBe(1);

		try {
			const statuses = probe
				.prepare(`SELECT status, COUNT(*) AS count FROM messages GROUP BY status`)
				.all() as Array<{
				status: string;
				count: number;
			}>;
			expect(statuses).toEqual(
				expect.arrayContaining([
					{ status: "pending", count: 1 },
					{ status: "unread", count: 1 },
				]),
			);
			expect(statuses.some((row) => row.status === "read")).toBe(false);
		} finally {
			probe.close();
		}
	});

	it("GC: reclaims mixed-version read rows whose old writer left read_at null", () => {
		const hub = freshStore({ readMessageRetentionMs: 1_000 });
		const path = join(dirs.at(-1)!, "g.db");
		const id = hub.send("alice", "recipient", "legacy delivery");
		const old = new Date(Date.now() - 10_000).toISOString();
		const probe = new DatabaseSync(path);
		try {
			probe.prepare(`UPDATE messages SET status = 'read', read_at = NULL, drained_at = ? WHERE id = ?`).run(old, id);
			expect(hub.purgeExpiredReadMessages(Date.now())).toBe(1);
		} finally {
			probe.close();
		}
	});

	it("GC: coordinates hourly maintenance across independent store handles", () => {
		const dir = mkdtempSync(join(tmpdir(), "gossip-maintenance-lease-"));
		dirs.push(dir);
		const path = join(dir, "messages.db");
		const first = new MessageStore(path, { readMessageRetentionMs: 0 });
		const second = new MessageStore(path, { readMessageRetentionMs: 0 });
		stores.push(first, second);
		const now = Date.now() + 1_000;
		first.maybeRunMaintenance(now);

		const probe = new DatabaseSync(path);
		try {
			probe
				.prepare(
					`INSERT INTO messages
					 (id, sender, recipient, content, created_at, status, read_at, priority)
					 VALUES ('m:leased-gc', 'a', 'b', 'body', ?, 'read', ?, 'normal')`,
				)
				.run(new Date(now - 1_000).toISOString(), new Date(now - 1_000).toISOString());

			// A second process may attempt maintenance, but the shared completion
			// timestamp prevents another scan in the same hour.
			second.maybeRunMaintenance(now + 1);
			expect(
				(
					probe.prepare(`SELECT COUNT(*) AS count FROM messages WHERE id = 'm:leased-gc'`).get() as {
						count: number;
					}
				).count,
			).toBe(1);

			second.maybeRunMaintenance(now + 60 * 60 * 1_000 + 1);
			expect(
				(
					probe.prepare(`SELECT COUNT(*) AS count FROM messages WHERE id = 'm:leased-gc'`).get() as {
						count: number;
					}
				).count,
			).toBe(0);
		} finally {
			probe.close();
		}
	});

	it("GC: bounds each maintenance pass to avoid a single large WAL transaction", () => {
		const dir = mkdtempSync(join(tmpdir(), "gossip-maintenance-batch-"));
		dirs.push(dir);
		const path = join(dir, "messages.db");
		const hub = new MessageStore(path, { readMessageRetentionMs: 0 });
		stores.push(hub);
		const probe = new DatabaseSync(path);
		try {
			const insert = probe.prepare(
				`INSERT INTO messages
				 (id, sender, recipient, content, created_at, status, read_at, priority)
				 VALUES (?, 'a', 'b', 'body', ?, 'read', ?, 'normal')`,
			);
			const old = new Date(Date.now() - 1_000).toISOString();
			probe.exec("BEGIN IMMEDIATE");
			for (let index = 0; index < 4_500; index++) insert.run(`m:batch-${index}`, old, old);
			probe.exec("COMMIT");

			expect(hub.runMaintenance(Date.now()).readMessages).toBe(4_000);
			expect((probe.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count).toBe(500);
			expect(hub.runMaintenance(Date.now()).readMessages).toBe(500);
		} finally {
			probe.close();
		}
	});

	it("GC: peer_seen retention cannot undercut the V1 delayed-flood window", () => {
		const dir = mkdtempSync(join(tmpdir(), "gossip-seen-invalid-"));
		dirs.push(dir);
		expect(
			() =>
				new MessageStore(join(dir, "invalid.db"), {
					peerOutboxRetentionMs: 10_000,
					peerSeenRetentionMs: 19_999,
				}),
		).toThrow(/at least 20000ms/);
	});

	it("GC: scheduled maintenance bounds peer_seen without deleting active dedup state", () => {
		const dir = mkdtempSync(join(tmpdir(), "gossip-seen-gc-"));
		dirs.push(dir);
		const path = join(dir, "seen.db");
		const hub = new MessageStore(path, {
			peerOutboxRetentionMs: 10_000,
			peerSeenRetentionMs: 20_000,
		});
		stores.push(hub);
		hub.updatePresence("local-recipient", "idle");
		const localId = hub.send("alice", "local-recipient", "local body");
		const routed = hub.sendRouted("alice", "remote-recipient", "remote body");
		hub.claimPeerOutbox("store:leaf", "relay", 10);
		hub.ackPeerOutbox([routed.id], "relay", { durableCustody: true });
		const probe = new DatabaseSync(path);
		try {
			const now = Date.now();
			const localCreatedAt = (
				probe.prepare(`SELECT created_at FROM messages WHERE id = ?`).get(localId) as { created_at: string }
			).created_at;
			const updateSeen = probe.prepare(`UPDATE peer_seen SET first_seen_at = ? WHERE message_id IN (?, ?)`);
			const countSeen = probe.prepare(`SELECT COUNT(*) AS count FROM peer_seen WHERE message_id IN (?, ?)`);

			// Fifteen seconds is outside the 10s outbox window but still inside the
			// required 20s (two-hop) dedup window. Scheduled maintenance keeps both.
			updateSeen.run(new Date(now - 15_000).toISOString(), localId, routed.id);
			hub.runMaintenance();
			expect((countSeen.get(localId, routed.id) as { count: number }).count).toBe(2);

			// Once the dedup window expires, an inbox-only marker can be reclaimed,
			// while the marker for a still-live outbox body remains protected.
			updateSeen.run(new Date(now - 25_000).toISOString(), localId, routed.id);
			hub.runMaintenance();
			expect((countSeen.get(localId, localId) as { count: number }).count).toBe(0);
			expect((countSeen.get(routed.id, routed.id) as { count: number }).count).toBe(1);
			expect(hub.unreadCount("local-recipient")).toBe(1);

			// The inbox primary key still rejects a replay and recreates its marker;
			// reclaiming peer_seen never duplicates the durable inbox row.
			expect(
				hub.acceptFederatedMessage(
					{
						id: localId,
						sender: "alice",
						recipient: "local-recipient",
						content: "local body",
						createdAt: localCreatedAt,
						priority: "normal",
					},
					"store:replay",
				).disposition,
			).toBe("duplicate");
			expect(hub.unreadCount("local-recipient")).toBe(1);

			// Once the settled outbox body expires, one maintenance pass deletes body,
			// per-link delivery ledger, and its now-unprotected dedup marker.
			probe
				.prepare(`UPDATE peer_outbox SET settled_at = ? WHERE message_id = ?`)
				.run(new Date(now - 15_000).toISOString(), routed.id);
			hub.runMaintenance();
			expect(
				(
					probe.prepare(`SELECT COUNT(*) AS count FROM peer_outbox WHERE message_id = ?`).get(routed.id) as {
						count: number;
					}
				).count,
			).toBe(0);
			expect(
				(
					probe
						.prepare(`SELECT COUNT(*) AS count FROM peer_outbox_delivery WHERE message_id = ?`)
						.get(routed.id) as { count: number }
				).count,
			).toBe(0);
			expect((countSeen.get(routed.id, routed.id) as { count: number }).count).toBe(0);
			expect((countSeen.get(localId, localId) as { count: number }).count).toBe(1);
		} finally {
			probe.close();
		}
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
		a.ackPeerOutbox([sent.id], "a-hub-relay", { durableCustody: true });

		// Hub's link to C claims and forwards; C accepts (carol IS local) -> local.
		const [fromHub] = hub.claimPeerOutbox("store:c", "hub-c-relay", 10);
		expect(fromHub.id).toBe(sent.id);
		expect(c.acceptFederatedMessage(fromHub, "store:hub").disposition).toBe("local");
		hub.ackPeerOutbox([sent.id], "hub-c-relay", { durableCustody: true });

		// Carol receives it, id and content preserved.
		const drained = c.drainUnread("carol");
		expect(drained).toHaveLength(1);
		expect(drained[0].id).toBe(sent.id);
		expect(drained[0].content).toBe("hi carol");

		// Hub never echoes back to A: A's link finds nothing new.
		expect(hub.claimPeerOutbox("store:a", "hub-a-relay", 10)).toHaveLength(0);
	});
});
