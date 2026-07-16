import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type PeerLinkEnvelope, serializePeerLinkFrame } from "../src/core/peer-link-protocol.ts";
import { PeerLinkSession, type PeerLinkStorage } from "../src/core/peer-link-session.ts";

type OutboxRow = {
	message: PeerLinkEnvelope;
	target?: string;
	status: "pending" | "inflight" | "forwarded";
	owner?: string;
	retryAfter?: number;
};

class MemoryPeerStore implements PeerLinkStorage {
	readonly routes = new Map<string, string>();
	readonly outbox: OutboxRow[] = [];
	readonly inbox: PeerLinkEnvelope[] = [];
	notFoundRequeues = 0;
	private readonly seen = new Set<string>();
	private readonly storeId: string;
	private readonly sessions: string[];

	constructor(storeId: string, sessions: string[]) {
		this.storeId = storeId;
		this.sessions = sessions;
	}

	getStoreId() {
		return this.storeId;
	}

	listRegisteredSessionIds() {
		return [...this.sessions];
	}

	replacePeerRoutes(peerStoreId: string, sessionIds: string[]) {
		for (const [sessionId, route] of this.routes) if (route === peerStoreId) this.routes.delete(sessionId);
		for (const sessionId of sessionIds) this.routes.set(sessionId, peerStoreId);
	}

	claimOutbound(peerStoreId: string, ownerId: string, includeUnresolved: boolean, limit: number) {
		const claimed: PeerLinkEnvelope[] = [];
		for (const row of this.outbox) {
			if (claimed.length >= limit) break;
			if (row.status !== "pending" || (row.retryAfter ?? 0) > Date.now()) continue;
			if (row.target !== peerStoreId && !(includeUnresolved && row.target === undefined)) continue;
			row.status = "inflight";
			row.owner = ownerId;
			claimed.push(row.message);
		}
		return claimed;
	}

	ackOutbound(messageIds: string[], ownerId: string) {
		for (const row of this.outbox) {
			if (messageIds.includes(row.message.id) && row.status === "inflight" && row.owner === ownerId) {
				row.status = "forwarded";
				row.owner = undefined;
			}
		}
	}

	requeueOutbound(messageIds: string[], ownerId: string, options?: { notFound?: boolean }) {
		if (options?.notFound) this.notFoundRequeues += messageIds.length;
		for (const row of this.outbox) {
			if (messageIds.includes(row.message.id) && row.status === "inflight" && row.owner === ownerId) {
				row.status = "pending";
				row.owner = undefined;
				if (options?.notFound) row.retryAfter = Date.now() + 50;
				else delete row.retryAfter;
			}
		}
	}

	acceptIncoming(message: PeerLinkEnvelope, ingressPeerStoreId: string) {
		if (this.seen.has(message.id)) return { status: "duplicate" as const };
		if (this.sessions.includes(message.recipient)) {
			this.seen.add(message.id);
			this.inbox.push(message);
			return { status: "accepted" as const, localRecipient: message.recipient };
		}
		const route = this.routes.get(message.recipient);
		if (!route || route === ingressPeerStoreId || message.hopsRemaining === 0)
			return { status: "not_found" as const };
		this.seen.add(message.id);
		this.outbox.push({ message, target: route, status: "pending" });
		return { status: "accepted" as const };
	}
}

function envelope(id: string, sender: string, recipient: string, originStoreId: string): PeerLinkEnvelope {
	return {
		id,
		originStoreId,
		sender,
		recipient,
		content: `message ${id}`,
		createdAt: new Date().toISOString(),
		priority: "urgent",
		visitedStoreIds: [originStoreId],
		hopsRemaining: 2,
	};
}

function linkedSessions(
	initiatorStore: PeerLinkStorage,
	responderStore: PeerLinkStorage,
	onResponderRecipient?: (sessionId: string) => void,
) {
	const initiatorToResponder = new PassThrough();
	const responderToInitiator = new PassThrough();
	const initiator = new PeerLinkSession({
		role: "initiator",
		input: responderToInitiator,
		output: initiatorToResponder,
		storage: initiatorStore,
		includeUnresolvedOutbound: true,
		flushIntervalMs: 5,
		sessionRefreshIntervalMs: 5,
	});
	const responder = new PeerLinkSession({
		role: "responder",
		input: initiatorToResponder,
		output: responderToInitiator,
		storage: responderStore,
		flushIntervalMs: 5,
		sessionRefreshIntervalMs: 5,
		onLocalRecipient: onResponderRecipient,
	});
	return { initiator, responder };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for peer link state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("PeerLinkSession", () => {
	it("requeues an entire claimed batch when the first message write fails", async () => {
		class FailAfterHello extends PassThrough {
			private writes = 0;

			override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
				this.writes += 1;
				if (this.writes === 2) {
					callback(new Error("injected message write failure"));
					return;
				}
				super._write(chunk, encoding, callback);
			}
		}

		const local = new MemoryPeerStore("store-a", ["session-a"]);
		const remote = new MemoryPeerStore("store-b", ["session-b"]);
		for (let index = 0; index < 3; index++) {
			local.outbox.push({
				message: envelope(`m:failed-${index}`, "session-a", "session-b", "store-a"),
				status: "pending",
			});
		}
		const initiatorToResponder = new FailAfterHello();
		const responderToInitiator = new PassThrough();
		let failed = false;
		const initiator = new PeerLinkSession({
			role: "initiator",
			input: responderToInitiator,
			output: initiatorToResponder,
			storage: local,
			includeUnresolvedOutbound: true,
			batchSize: 3,
			onState: (state) => {
				if (state === "failed") failed = true;
			},
		});
		const responder = new PeerLinkSession({
			role: "responder",
			input: initiatorToResponder,
			output: responderToInitiator,
			storage: remote,
		});
		try {
			await Promise.all([responder.start(), initiator.start()]);
			await waitFor(() => failed);
			expect(local.outbox.map((row) => row.status)).toEqual(["pending", "pending", "pending"]);
			expect(remote.inbox).toHaveLength(0);
		} finally {
			await Promise.all([initiator.close(), responder.close()]);
		}
	});

	it("bounds claimed messages while a peer withholds acknowledgements", async () => {
		const local = new MemoryPeerStore("store-a", ["session-a"]);
		for (let index = 0; index < 25; index++) {
			local.outbox.push({
				message: envelope(`m:withheld-${index}`, "session-a", "session-b", "store-a"),
				target: "store-b",
				status: "pending",
			});
		}
		const input = new PassThrough();
		const output = new PassThrough();
		const link = new PeerLinkSession({
			role: "initiator",
			input,
			output,
			storage: local,
			batchSize: 10,
			flushIntervalMs: 1,
		});
		try {
			const started = link.start();
			input.write(
				serializePeerLinkFrame({ type: "hello_ack", protocol: 1, storeId: "store-b", sessions: ["session-b"] }),
			);
			await started;
			await waitFor(() => local.outbox.filter((row) => row.status === "inflight").length === 10);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(local.outbox.filter((row) => row.status === "inflight")).toHaveLength(10);
			expect(local.outbox.filter((row) => row.status === "pending")).toHaveLength(15);
		} finally {
			await link.close();
		}
	});

	it("rejects a first-hop sender not owned by the advertised origin store", async () => {
		const local = new MemoryPeerStore("store-a", ["session-a"]);
		const remote = new MemoryPeerStore("store-b", ["session-b"]);
		local.outbox.push(
			{
				message: envelope("m:spoofed", "forged-session", "session-b", "store-a"),
				status: "pending",
			},
			{
				message: {
					...envelope("m:spoofed-relay", "victim-session", "session-b", "store:victim"),
					visitedStoreIds: ["store:victim", "store-a"],
					hopsRemaining: 1,
				},
				status: "pending",
			},
		);
		const link = linkedSessions(local, remote);
		try {
			await Promise.all([link.responder.start(), link.initiator.start()]);
			await waitFor(() => local.notFoundRequeues >= 2);
			expect(remote.inbox).toHaveLength(0);
		} finally {
			await Promise.all([link.initiator.close(), link.responder.close()]);
		}
	});

	it("handshakes, transfers, acknowledges, and deduplicates a direct message", async () => {
		const local = new MemoryPeerStore("store-a", ["session-a"]);
		const remote = new MemoryPeerStore("store-b", ["session-b"]);
		local.outbox.push({ message: envelope("m:direct", "session-a", "session-b", "store-a"), status: "pending" });
		const recipients: string[] = [];
		const link = linkedSessions(local, remote, (sessionId) => recipients.push(sessionId));
		try {
			await Promise.all([link.responder.start(), link.initiator.start()]);
			await waitFor(() => remote.inbox.length === 1 && local.outbox[0]?.status === "forwarded");
			expect(remote.inbox[0]?.id).toBe("m:direct");
			expect(recipients).toEqual(["session-b"]);
			expect(local.routes.get("session-b")).toBe("store-b");
		} finally {
			await Promise.all([link.initiator.close(), link.responder.close()]);
		}
	});

	it("uses one server store to relay between two client SSH links", async () => {
		const clientA = new MemoryPeerStore("store-a", ["session-a"]);
		const hub = new MemoryPeerStore("store-hub", ["session-hub"]);
		const clientB = new MemoryPeerStore("store-b", ["session-b"]);
		const aHub = linkedSessions(clientA, hub);
		const bHub = linkedSessions(clientB, hub);
		clientA.outbox.push({ message: envelope("m:relay", "session-a", "session-b", "store-a"), status: "pending" });
		try {
			await Promise.all([
				aHub.responder.start(),
				aHub.initiator.start(),
				bHub.responder.start(),
				bHub.initiator.start(),
			]);
			await waitFor(() => clientB.inbox.length === 1 && clientA.outbox[0]?.status === "forwarded");
			expect(clientB.inbox[0]).toMatchObject({ id: "m:relay", sender: "session-a", recipient: "session-b" });
			expect(hub.routes.get("session-a")).toBe("store-a");
			expect(hub.routes.get("session-b")).toBe("store-b");
			expect(hub.outbox.some((row) => row.message.id === "m:relay" && row.status === "forwarded")).toBe(true);
		} finally {
			await Promise.all([
				aHub.initiator.close(),
				aHub.responder.close(),
				bHub.initiator.close(),
				bHub.responder.close(),
			]);
		}
	});
});
