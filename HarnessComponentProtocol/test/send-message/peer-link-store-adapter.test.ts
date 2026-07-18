import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import { PeerLinkSession } from "../../tools/send-message/magenta/peer-link-session.ts";
import { MessageStorePeerLinkAdapter } from "../../tools/send-message/magenta/peer-link-store-adapter.ts";

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
			expect(hub.getPeerOutboxCounts().forwarded).toBe(1);
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
