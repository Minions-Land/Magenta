import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import {
	PEER_LINK_CAPABILITY_GOSSIP_TRANSIT,
	parsePeerLinkFrame,
	serializePeerLinkFrame,
} from "../../tools/send-message/magenta/peer-link-protocol.ts";
import { PeerLinkSession } from "../../tools/send-message/magenta/peer-link-session.ts";
import { MessageStorePeerLinkAdapter } from "../../tools/send-message/magenta/peer-link-store-adapter.ts";
import { DatabaseSync } from "../../tools/send-message/magenta/sqlite-adapter.ts";

function link(initiatorStore: MessageStore, responderStore: MessageStore) {
	const up = new PassThrough();
	const down = new PassThrough();
	const initiator = new PeerLinkSession({
		role: "initiator",
		input: down,
		output: up,
		storage: new MessageStorePeerLinkAdapter(initiatorStore),
		includeUnresolvedOutbound: true,
		flushIntervalMs: 5,
		sessionRefreshIntervalMs: 5,
	});
	const responder = new PeerLinkSession({
		role: "responder",
		input: up,
		output: down,
		storage: new MessageStorePeerLinkAdapter(responderStore),
		flushIntervalMs: 5,
		sessionRefreshIntervalMs: 5,
	});
	return { initiator, responder };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for federated SQLite delivery");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("MessageStorePeerLinkAdapter", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("orders local advertisements by live state and then recent presence", () => {
		const dir = mkdtempSync(join(tmpdir(), "peer-link-presence-priority-"));
		dirs.push(dir);
		const path = join(dir, "store.db");
		const store = new MessageStore(path, { storeId: "store-priority" });
		const deadPid = 2_147_483_646;
		try {
			store.updatePresence("z-live-active", "active", { pid: process.pid, bootId: "active" });
			store.updatePresence("y-live-idle", "idle", { pid: process.pid, bootId: "idle" });
			store.updatePresence("a-stale-active", "active", { pid: deadPid, bootId: "stale" });
			store.updatePresence("b-offline-recent", "offline");
			store.updatePresence("c-offline-old", "offline");

			const probe = new DatabaseSync(path);
			try {
				const setSeen = probe.prepare(`UPDATE presence SET last_seen = ? WHERE agent_id = ?`);
				setSeen.run("2000-01-01T00:00:00.000Z", "z-live-active");
				setSeen.run("2001-01-01T00:00:00.000Z", "y-live-idle");
				setSeen.run("2003-01-01T00:00:00.000Z", "a-stale-active");
				setSeen.run("2004-01-01T00:00:00.000Z", "b-offline-recent");
				setSeen.run("2002-01-01T00:00:00.000Z", "c-offline-old");
			} finally {
				probe.close();
			}

			expect(store.listRegisteredSessionIds()).toEqual([
				"z-live-active",
				"y-live-idle",
				"b-offline-recent",
				"a-stale-active",
				"c-offline-old",
			]);

			store.updatePresence("a-stale-active", "active", { pid: process.pid, bootId: "revived" });
			expect(store.listRegisteredSessionIds()).toEqual([
				"a-stale-active",
				"z-live-active",
				"y-live-idle",
				"b-offline-recent",
				"c-offline-old",
			]);
		} finally {
			store.close();
		}
	});

	it("claims only direct rows for a legacy peer and leaves transit claimable after upgrade", () => {
		const dir = mkdtempSync(join(tmpdir(), "peer-link-capability-"));
		dirs.push(dir);
		const hub = new MessageStore(join(dir, "hub.db"), { storeId: "store-hub" });
		const adapter = new MessageStorePeerLinkAdapter(hub);
		try {
			// Persist transit first so a direct-only query must skip the queue head.
			expect(
				adapter.acceptIncoming(
					{
						id: "m:transit-pending",
						originStoreId: "store-origin",
						sender: "origin-session",
						recipient: "session-old",
						content: "relay after upgrade",
						createdAt: "2026-07-20T00:00:00.000Z",
						priority: "normal",
						visitedStoreIds: ["store-origin", "store-hub"],
						hopsRemaining: 1,
					},
					"store-origin",
				),
			).toEqual({ status: "accepted" });
			const direct = hub.sendRouted("hub-session", "session-old", "direct to old peer");

			const legacyClaim = adapter.claimOutbound("store-old", "legacy-owner", true, 10, {
				allowTransit: false,
			});
			expect(legacyClaim.map((message) => message.id)).toEqual([direct.id]);
			adapter.ackOutbound([direct.id], "legacy-owner", { durableCustody: true });

			// No delivery row was created for the skipped transit message. The same
			// peer store can claim it immediately after advertising capability.
			const upgradedClaim = adapter.claimOutbound("store-old", "upgraded-owner", true, 10, {
				allowTransit: true,
			});
			expect(upgradedClaim.map((message) => message.id)).toEqual(["m:transit-pending"]);
		} finally {
			hub.close();
		}
	});

	it("does not claim for a transit-only peer and retains the payload until a custody-capable reconnect", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peer-link-transit-only-"));
		dirs.push(dir);
		const sourcePath = join(dir, "source.db");
		const source = new MessageStore(sourcePath, { storeId: "store-source", peerOutboxRetentionMs: 1_000 });
		source.updatePresence("source-session", "idle");
		const sent = source.sendRouted("source-session", "target-session", "wait for durable custody");
		const toPrevious = new PassThrough();
		const fromPrevious = new PassThrough();
		let wire = "";
		toPrevious.on("data", (chunk) => {
			wire += chunk.toString();
		});
		const previousLink = new PeerLinkSession({
			role: "initiator",
			input: fromPrevious,
			output: toPrevious,
			storage: new MessageStorePeerLinkAdapter(source),
			includeUnresolvedOutbound: true,
			flushIntervalMs: 5,
			sessionRefreshIntervalMs: 1_000,
		});
		const probe = new DatabaseSync(sourcePath);
		try {
			const started = previousLink.start();
			await waitFor(() => wire.includes("\n"));
			fromPrevious.write(
				serializePeerLinkFrame({
					type: "hello_ack",
					protocol: 1,
					storeId: "store-previous",
					sessions: ["target-session"],
					capabilities: [PEER_LINK_CAPABILITY_GOSSIP_TRANSIT],
				}),
			);
			await started;
			await new Promise((resolve) => setTimeout(resolve, 25));
			const frames = wire
				.trimEnd()
				.split("\n")
				.map((line) => parsePeerLinkFrame(line));
			expect(frames.some((frame) => frame.type === "message")).toBe(false);
			expect(
				probe.prepare(`SELECT COUNT(*) AS count FROM peer_outbox_delivery WHERE message_id = ?`).get(sent.id),
			).toEqual({ count: 0 });
			expect(source.purgeExpiredOutbox(Date.now() + 30 * 24 * 60 * 60 * 1_000)).toBe(0);
			expect(probe.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`).get(sent.id)).toEqual({
				settled_at: null,
			});
		} finally {
			await previousLink.close();
			probe.close();
		}

		const upgraded = new MessageStore(join(dir, "upgraded.db"), { storeId: "store-previous" });
		upgraded.updatePresence("target-session", "idle");
		const currentLink = link(source, upgraded);
		try {
			await Promise.all([currentLink.responder.start(), currentLink.initiator.start()]);
			await waitFor(() => upgraded.unreadCount("target-session") === 1);
			const custodyProbe = new DatabaseSync(sourcePath);
			try {
				const custody = custodyProbe
					.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`)
					.get(sent.id) as { settled_at: string };
				expect(custody.settled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				expect(source.purgeExpiredOutbox(Date.parse(custody.settled_at) + 999)).toBe(0);
				expect(source.purgeExpiredOutbox(Date.parse(custody.settled_at) + 1_000)).toBe(1);
			} finally {
				custodyProbe.close();
			}
		} finally {
			await Promise.all([currentLink.initiator.close(), currentLink.responder.close()]);
			source.close();
			upgraded.close();
		}
	});

	it("relays one source-generated id and structured metadata through a hub database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peer-link-store-"));
		dirs.push(dir);
		const a = new MessageStore(join(dir, "a.db"), { storeId: "store-a" });
		const hub = new MessageStore(join(dir, "hub.db"), { storeId: "store-hub" });
		const b = new MessageStore(join(dir, "b.db"), { storeId: "store-b" });
		a.updatePresence("session-a", "idle");
		b.updatePresence("session-b", "idle");
		const sent = a.sendRouted("session-a", "session-b", "hello through hub", "urgent", {
			routeTag: "route-1",
			relayState: "completed",
		});
		const aHub = link(a, hub);
		const bHub = link(b, hub);
		try {
			await Promise.all([
				aHub.responder.start(),
				aHub.initiator.start(),
				bHub.responder.start(),
				bHub.initiator.start(),
			]);
			await waitFor(() => b.unreadCount("session-b") === 1);
			const [received] = b.drainUnread("session-b");
			expect(received).toMatchObject({
				id: sent.id,
				sender: "session-a",
				recipient: "session-b",
				content: "hello through hub",
				metadata: { routeTag: "route-1", relayState: "completed" },
			});
			expect(a.getPeerOutboxCounts().forwarded).toBe(1);
			// Under pure gossip the hub's per-link delivery ledger holds two rows for
			// this message: the A-link is pre-marked forwarded (ingress echo guard) and
			// the B-link is forwarded on real delivery. Both count as forwarded.
			expect(hub.getPeerOutboxCounts().forwarded).toBe(2);

			const sourceProbe = new DatabaseSync(join(dir, "a.db"));
			try {
				const custody = sourceProbe
					.prepare(`SELECT settled_at FROM peer_outbox WHERE message_id = ?`)
					.get(sent.id) as { settled_at: string };
				expect(custody.settled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				const retentionMs = 7 * 24 * 60 * 60 * 1_000;
				expect(a.purgeExpiredOutbox(Date.parse(custody.settled_at) + retentionMs - 1)).toBe(0);
				expect(a.purgeExpiredOutbox(Date.parse(custody.settled_at) + retentionMs)).toBe(1);
			} finally {
				sourceProbe.close();
			}
		} finally {
			await Promise.all([
				aHub.initiator.close(),
				aHub.responder.close(),
				bHub.initiator.close(),
				bHub.responder.close(),
			]);
			a.close();
			hub.close();
			b.close();
		}
	});
});
