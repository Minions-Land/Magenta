import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyMessageStore } from "../../tools/send-message/magenta/legacy-message-store.ts";
import { MessageStore, PEER_FEDERATION_METADATA_KEY } from "../../tools/send-message/magenta/message-store.ts";
import { PeerLinkSession } from "../../tools/send-message/magenta/peer-link-session.ts";
import { MessageStorePeerLinkAdapter } from "../../tools/send-message/magenta/peer-link-store-adapter.ts";
import { DatabaseSync } from "../../tools/send-message/magenta/sqlite-adapter.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for migrated peer delivery");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function connectStores(source: MessageStore, destination: MessageStore): Promise<() => Promise<void>> {
	const sourceToDestination = new PassThrough();
	const destinationToSource = new PassThrough();
	const initiator = new PeerLinkSession({
		role: "initiator",
		input: destinationToSource,
		output: sourceToDestination,
		storage: new MessageStorePeerLinkAdapter(source),
		includeUnresolvedOutbound: true,
		flushIntervalMs: 5,
	});
	const responder = new PeerLinkSession({
		role: "responder",
		input: sourceToDestination,
		output: destinationToSource,
		storage: new MessageStorePeerLinkAdapter(destination),
		flushIntervalMs: 5,
	});
	await Promise.all([responder.start(), initiator.start()]);
	return async () => {
		await Promise.all([initiator.close(), responder.close()]);
	};
}

describe("legacy message-store path migration", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
	});

	function paths(): { source: string; target: string } {
		const dir = mkdtempSync(join(tmpdir(), "legacy-message-store-"));
		dirs.push(dir);
		return { source: join(dir, "agent", "messages.db"), target: join(dir, "messages.db") };
	}

	it("moves delivery-relevant inbox state and preserves offline routing ownership", () => {
		const { source, target } = paths();
		const legacy = new MessageStore(source);
		const unread = legacy.send("alice", "unread-recipient", "still waiting", "urgent", { source: "legacy" });
		const pending = legacy.send("bob", "pending-recipient", "claimed before crash", "normal");
		legacy.drainUnread("pending-recipient", undefined, { ownerId: "old-owner", pid: 999_999_999 });
		const read = legacy.send("carol", "read-recipient", "already delivered", "normal");
		const drainedRead = legacy.drainUnread("read-recipient");
		legacy.markDelivered(drainedRead.map((message) => message.id));
		legacy.updatePresence("unrelated-history", "active", {
			pid: process.pid,
			bootId: "legacy-boot",
			wakePath: "legacy-wake",
		});
		legacy.close();

		const result = migrateLegacyMessageStore(source, target);
		expect(result).toEqual({
			sourceMessages: 2,
			insertedMessages: 2,
			sourceOutbox: 0,
			insertedOutbox: 0,
			removedSource: false,
		});
		expect(existsSync(source)).toBe(true);

		const current = new MessageStore(target);
		try {
			expect(current.drainUnread("unread-recipient").map((message) => message.id)).toEqual([unread]);
			expect(current.drainUnread("pending-recipient").map((message) => message.id)).toEqual([pending]);
			expect(current.unreadCount("read-recipient")).toBe(0);
			expect(current.getPresence("unread-recipient")?.state).toBe("offline");
			expect(current.getPresence("pending-recipient")?.state).toBe("offline");
			expect(current.getPresence("unrelated-history")).toEqual(
				expect.objectContaining({ state: "offline", online: false, pid: null, bootId: null, wakePath: null }),
			);
			expect(current.sendRouted("dave", "unrelated-history", "still locally owned").disposition).toBe("local");
		} finally {
			current.close();
		}
		const retained = new MessageStore(source);
		try {
			expect(retained.unreadCount("unread-recipient")).toBe(0);
			expect(retained.unreadCount("pending-recipient")).toBe(0);
		} finally {
			retained.close();
		}
		expect(read).not.toBe(unread);
	});

	it("is idempotent and preserves a legacy endpoint's manual-off state", () => {
		const { source, target } = paths();
		const legacy = new MessageStore(source);
		const message = legacy.send("alice", "recipient", "once", "normal");
		legacy.upsertPeerEndpoint("legacy-endpoint", "example.invalid");
		legacy.setPeerEndpointRelayGeneration("legacy-endpoint", "legacy-generation");
		expect(
			legacy.claimPeerEndpointRelay("legacy-endpoint", process.pid, "legacy-relay-owner", {
				generation: "legacy-generation",
			}),
		).toBe(true);
		legacy.setPeerEndpointDesiredState("legacy-endpoint", "off");
		legacy.close();

		const first = migrateLegacyMessageStore(source, target);
		const second = migrateLegacyMessageStore(source, target);
		expect(first).toEqual({
			sourceMessages: 1,
			insertedMessages: 1,
			sourceOutbox: 0,
			insertedOutbox: 0,
			removedSource: false,
		});
		expect(second).toEqual({
			sourceMessages: 0,
			insertedMessages: 0,
			sourceOutbox: 0,
			insertedOutbox: 0,
			removedSource: false,
		});

		const current = new MessageStore(target);
		try {
			expect(current.drainUnread("recipient").map((entry) => entry.id)).toEqual([message]);
			expect(current.getPeerEndpoint("legacy-endpoint")).toEqual(
				expect.objectContaining({
					remote: "example.invalid",
					desiredState: "off",
					observedState: "closed",
				}),
			);
			expect(current.getPeerEndpoint("legacy-endpoint")).not.toHaveProperty("relayPid");
			expect(current.getPeerEndpoint("legacy-endpoint")).not.toHaveProperty("relayGeneration");
		} finally {
			current.close();
		}
	});

	it("imports late legacy writes without resurrecting previously settled messages", () => {
		const { source, target } = paths();
		const legacy = new MessageStore(source);
		const firstId = legacy.send("alice", "recipient", "first", "normal");
		legacy.close();

		expect(migrateLegacyMessageStore(source, target)).toEqual({
			sourceMessages: 1,
			insertedMessages: 1,
			sourceOutbox: 0,
			insertedOutbox: 0,
			removedSource: false,
		});
		const current = new MessageStore(target, { readMessageRetentionMs: 0 });
		const firstDelivery = current.drainUnread("recipient");
		expect(firstDelivery.map((message) => message.id)).toEqual([firstId]);
		current.markDelivered([firstId]);
		expect(current.purgeExpiredReadMessages(Date.now() + 1_000)).toBe(1);
		current.close();

		// Model a crash after the target message + import marker committed but
		// before the ordered source-only settlement finished. The next startup must
		// settle the source without resurrecting the now-retained-away target row.
		const interruptedSource = new DatabaseSync(source);
		interruptedSource.prepare(`UPDATE messages SET status = 'unread', read_at = NULL WHERE id = ?`).run(firstId);
		interruptedSource.close();
		expect(migrateLegacyMessageStore(source, target)).toEqual({
			sourceMessages: 1,
			insertedMessages: 0,
			sourceOutbox: 0,
			insertedOutbox: 0,
			removedSource: false,
		});
		const noResurrection = new MessageStore(target);
		expect(noResurrection.unreadCount("recipient")).toBe(0);
		noResurrection.close();

		// Model an old binary that still has the retained source open and writes
		// after the previous cross-database transaction committed.
		const oldWriter = new MessageStore(source);
		expect(oldWriter.unreadCount("recipient")).toBe(0);
		const lateId = oldWriter.send("bob", "recipient", "late", "urgent");
		oldWriter.close();

		expect(migrateLegacyMessageStore(source, target)).toEqual({
			sourceMessages: 1,
			insertedMessages: 1,
			sourceOutbox: 0,
			insertedOutbox: 0,
			removedSource: false,
		});
		const reopened = new MessageStore(target);
		try {
			expect(reopened.drainUnread("recipient").map((message) => message.id)).toEqual([lateId]);
		} finally {
			reopened.close();
		}
	});

	it("moves pending and inflight outbox payloads, resetting legacy claims before source cleanup", () => {
		const { source, target } = paths();
		const legacy = new MessageStore(source, { storeId: "store:legacy" });
		const inflight = legacy.sendRouted("alice", "remote-one", "claimed by the old relay", "urgent");
		expect(legacy.claimPeerOutbox("store:leaf", "legacy-owner", 10).map((message) => message.id)).toEqual([
			inflight.id,
		]);
		const pending = legacy.sendRouted("bob", "remote-two", "still pending", "normal");
		legacy.close();

		expect(migrateLegacyMessageStore(source, target)).toEqual({
			sourceMessages: 0,
			insertedMessages: 0,
			sourceOutbox: 2,
			insertedOutbox: 2,
			removedSource: false,
		});

		const sourceProbe = new DatabaseSync(source);
		try {
			expect(
				(sourceProbe.prepare(`SELECT COUNT(*) AS count FROM peer_outbox`).get() as { count: number }).count,
			).toBe(0);
			expect(
				(sourceProbe.prepare(`SELECT COUNT(*) AS count FROM peer_outbox_delivery`).get() as { count: number })
					.count,
			).toBe(0);
		} finally {
			sourceProbe.close();
		}

		const targetProbe = new DatabaseSync(target);
		try {
			expect(
				targetProbe
					.prepare(`SELECT status, claim_owner, claimed_at FROM peer_outbox_delivery WHERE message_id = ?`)
					.get(inflight.id),
			).toEqual({ status: "pending", claim_owner: null, claimed_at: null });
		} finally {
			targetProbe.close();
		}

		const current = new MessageStore(target);
		try {
			expect(
				new Set(current.claimPeerOutbox("store:leaf", "current-owner", 10).map((message) => message.id)),
			).toEqual(new Set([inflight.id, pending.id]));
		} finally {
			current.close();
		}
	});

	it("preserves rejected per-link deliveries without reviving them after migration", () => {
		const { source, target } = paths();
		const legacy = new MessageStore(source, { storeId: "store:legacy" });
		const rejected = legacy.sendRouted("alice", "remote", "do not hot retry");
		expect(legacy.claimPeerOutbox("store:leaf", "legacy-owner", 10).map((message) => message.id)).toEqual([
			rejected.id,
		]);
		expect(legacy.requeuePeerOutbox([rejected.id], "legacy-owner", { notFound: true })).toBe(1);
		legacy.close();

		expect(migrateLegacyMessageStore(source, target).insertedOutbox).toBe(1);
		const probe = new DatabaseSync(target);
		try {
			expect(
				probe
					.prepare(`SELECT status FROM peer_outbox_delivery WHERE message_id = ? AND peer_store_id = ?`)
					.get(rejected.id, "store:leaf"),
			).toEqual({ status: "rejected" });
		} finally {
			probe.close();
		}

		const current = new MessageStore(target);
		try {
			expect(
				current.claimPeerOutbox("store:leaf", "current-owner", 10, false, {
					allowTransit: true,
					reclaimUnsettledForwarded: true,
				}),
			).toHaveLength(0);
		} finally {
			current.close();
		}
	});

	it("rebases migrated transit envelopes to the target identity and removes an earlier target loop", async () => {
		const { source, target } = paths();
		const targetSeed = new MessageStore(target, { storeId: "store:target" });
		targetSeed.close();
		const legacy = new MessageStore(source, { storeId: "store:legacy" });
		for (const envelope of [
			{
				id: "m:migrated-transit",
				sender: "origin-sender",
				recipient: "transit-recipient",
				content: "continue through the migrated relay",
				createdAt: "2026-07-20T00:00:00.000Z",
				priority: "urgent" as const,
				metadata: {
					trace: "preserved",
					[PEER_FEDERATION_METADATA_KEY]: {
						originStoreId: "store:origin",
						visitedStoreIds: ["store:origin", "store:legacy"],
						hopsRemaining: 1,
					},
				},
			},
			{
				id: "m:migrated-target-loop",
				sender: "target-owned-sender",
				recipient: "loop-recipient",
				content: "collapse the legacy identity alias",
				createdAt: "2026-07-20T00:00:01.000Z",
				priority: "normal" as const,
				metadata: {
					[PEER_FEDERATION_METADATA_KEY]: {
						originStoreId: "store:target",
						visitedStoreIds: ["store:target", "store:legacy"],
						hopsRemaining: 1,
					},
				},
			},
		]) {
			expect(
				legacy.acceptFederatedMessage(envelope, envelope.metadata[PEER_FEDERATION_METADATA_KEY].originStoreId),
			).toEqual({ id: envelope.id, disposition: "relay" });
		}
		legacy.close();

		expect(migrateLegacyMessageStore(source, target)).toEqual({
			sourceMessages: 0,
			insertedMessages: 0,
			sourceOutbox: 2,
			insertedOutbox: 2,
			removedSource: false,
		});

		const probe = new DatabaseSync(target);
		try {
			const metadata = probe
				.prepare(`SELECT message_id, metadata_json FROM peer_outbox ORDER BY message_id`)
				.all() as Array<{
				message_id: string;
				metadata_json: string;
			}>;
			const federationById = new Map(
				metadata.map((row) => [
					row.message_id,
					(JSON.parse(row.metadata_json) as Record<string, any>)[PEER_FEDERATION_METADATA_KEY],
				]),
			);
			expect(federationById.get("m:migrated-transit")).toMatchObject({
				originStoreId: "store:origin",
				visitedStoreIds: ["store:origin", "store:target"],
				hopsRemaining: 1,
			});
			expect(federationById.get("m:migrated-target-loop")).toMatchObject({
				originStoreId: "store:target",
				visitedStoreIds: ["store:target"],
				hopsRemaining: 1,
			});
		} finally {
			probe.close();
		}

		const current = new MessageStore(target);
		const destination = new MessageStore(`${target}.destination`, { storeId: "store:destination" });
		destination.updatePresence("transit-recipient", "offline");
		destination.updatePresence("loop-recipient", "offline");
		let disconnect: (() => Promise<void>) | undefined;
		try {
			expect(current.hasRegisteredSession("target-owned-sender")).toBe(true);
			disconnect = await connectStores(current, destination);
			await waitFor(
				() => destination.unreadCount("transit-recipient") === 1 && destination.unreadCount("loop-recipient") === 1,
			);
			expect(destination.drainUnread("transit-recipient")[0]?.id).toBe("m:migrated-transit");
			expect(destination.drainUnread("loop-recipient")[0]?.id).toBe("m:migrated-target-loop");
		} finally {
			await disconnect?.();
			current.close();
			destination.close();
		}
	});

	it("restores first-hop sender ownership for a locally-originated outbox row", async () => {
		const { source, target } = paths();
		const targetSeed = new MessageStore(target, { storeId: "store:target" });
		targetSeed.close();
		const legacy = new MessageStore(source, { storeId: "store:legacy" });
		const sent = legacy.sendRouted("missing-presence-sender", "destination-session", "survive missing presence");
		expect(legacy.hasRegisteredSession("missing-presence-sender")).toBe(false);
		legacy.close();

		expect(migrateLegacyMessageStore(source, target).insertedOutbox).toBe(1);
		const current = new MessageStore(target);
		const destination = new MessageStore(`${target}.destination`, { storeId: "store:destination" });
		destination.updatePresence("destination-session", "offline");
		let disconnect: (() => Promise<void>) | undefined;
		try {
			expect(current.getPresence("missing-presence-sender")).toEqual(
				expect.objectContaining({ state: "offline", online: false }),
			);
			disconnect = await connectStores(current, destination);
			await waitFor(() => destination.unreadCount("destination-session") === 1);
			expect(destination.drainUnread("destination-session")[0]?.id).toBe(sent.id);
		} finally {
			await disconnect?.();
			current.close();
			destination.close();
		}
	});

	it("fails closed on malformed federation paths and leaves source payloads intact", () => {
		for (const scenario of [
			{ label: "empty path", visitedStoreIds: [], error: /federation metadata is invalid/ },
			{
				label: "wrong previous hop",
				visitedStoreIds: ["store:origin", "store:not-legacy"],
				error: /does not end at the source store/,
			},
		]) {
			const { source, target } = paths();
			const legacy = new MessageStore(source, { storeId: "store:legacy" });
			const sent = legacy.sendRouted("sender", `recipient-${scenario.label}`, scenario.label);
			legacy.close();
			const raw = new DatabaseSync(source);
			raw.prepare(`UPDATE peer_outbox SET metadata_json = ? WHERE message_id = ?`).run(
				JSON.stringify({
					[PEER_FEDERATION_METADATA_KEY]: {
						originStoreId: "store:origin",
						visitedStoreIds: scenario.visitedStoreIds,
						hopsRemaining: 1,
					},
				}),
				sent.id,
			);
			raw.close();

			expect(() => migrateLegacyMessageStore(source, target), scenario.label).toThrow(scenario.error);
			const sourceProbe = new DatabaseSync(source);
			const targetProbe = new DatabaseSync(target);
			try {
				expect(
					(
						sourceProbe
							.prepare(`SELECT COUNT(*) AS count FROM peer_outbox WHERE message_id = ?`)
							.get(sent.id) as {
							count: number;
						}
					).count,
				).toBe(1);
				expect(
					(
						targetProbe
							.prepare(`SELECT COUNT(*) AS count FROM peer_outbox WHERE message_id = ?`)
							.get(sent.id) as {
							count: number;
						}
					).count,
				).toBe(0);
			} finally {
				sourceProbe.close();
				targetProbe.close();
			}
		}
	});

	it("imports late outbox writes on the next migration pass", () => {
		const { source, target } = paths();
		const legacy = new MessageStore(source);
		const first = legacy.sendRouted("alice", "remote", "first outbox");
		legacy.close();
		expect(migrateLegacyMessageStore(source, target).insertedOutbox).toBe(1);

		const oldWriter = new MessageStore(source);
		const late = oldWriter.sendRouted("bob", "remote", "late outbox", "urgent");
		oldWriter.close();
		expect(migrateLegacyMessageStore(source, target)).toEqual({
			sourceMessages: 0,
			insertedMessages: 0,
			sourceOutbox: 1,
			insertedOutbox: 1,
			removedSource: false,
		});

		const current = new MessageStore(target);
		try {
			expect(new Set(current.claimPeerOutbox("store:leaf", "owner", 10).map((message) => message.id))).toEqual(
				new Set([first.id, late.id]),
			);
		} finally {
			current.close();
		}
	});

	it("rejects an outbox id collision with different contents and preserves the source payload", () => {
		const { source, target } = paths();
		for (const [path, content] of [
			[source, "legacy payload"],
			[target, "current payload"],
		] as const) {
			const store = new MessageStore(path);
			store.close();
			const raw = new DatabaseSync(path);
			raw.prepare(
				`INSERT INTO peer_outbox
				 (message_id, sender, recipient, content, created_at, priority, received_at)
				 VALUES ('m:same-outbox', 'alice', 'remote', ?, '2026-01-01T00:00:00.000Z', 'normal',
				         '2026-01-01T00:00:00.000Z')`,
			).run(content);
			raw.close();
		}

		expect(() => migrateLegacyMessageStore(source, target)).toThrow("conflicting outbox message id");
		const sourceProbe = new DatabaseSync(source);
		try {
			expect(
				sourceProbe.prepare(`SELECT content, settled_at FROM peer_outbox WHERE message_id = 'm:same-outbox'`).get(),
			).toEqual({ content: "legacy payload", settled_at: null });
		} finally {
			sourceProbe.close();
		}
	});

	it("rejects an id collision with different contents and retains the source", () => {
		const { source, target } = paths();
		for (const [path, content] of [
			[source, "legacy"],
			[target, "current"],
		] as const) {
			const store = new MessageStore(path);
			store.close();
			const raw = new DatabaseSync(path);
			raw.prepare(
				`INSERT INTO messages
				 (id, sender, recipient, content, created_at, status, priority)
				 VALUES ('m:same', 'alice', 'recipient', ?, '2026-01-01T00:00:00.000Z', 'unread', 'normal')`,
			).run(content);
			raw.close();
		}

		expect(() => migrateLegacyMessageStore(source, target)).toThrow("conflicting message id");
		expect(existsSync(source)).toBe(true);
	});
});
