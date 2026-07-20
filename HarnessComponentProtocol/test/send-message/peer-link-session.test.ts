import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	MAX_PEER_LINK_FRAME_BYTES,
	PEER_LINK_CAPABILITY_GOSSIP_TRANSIT,
	type PeerLinkEnvelope,
	parsePeerLinkFrame,
	serializePeerLinkFrame,
} from "../../tools/send-message/magenta/peer-link-protocol.ts";
import { PeerLinkSession, type PeerLinkStorage } from "../../tools/send-message/magenta/peer-link-session.ts";

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
	maintenanceRuns = 0;
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

	listAdvertisableSessions(_excludePeerStoreId?: string): string[] {
		// Memory store has no cross-peer route propagation; advertise local sessions.
		return [...this.sessions];
	}

	replacePeerRoutes(peerStoreId: string, sessionIds: string[]) {
		for (const [sessionId, route] of this.routes) if (route === peerStoreId) this.routes.delete(sessionId);
		for (const sessionId of sessionIds) this.routes.set(sessionId, peerStoreId);
	}

	claimOutbound(
		peerStoreId: string,
		ownerId: string,
		includeUnresolved: boolean,
		limit: number,
		options?: { allowTransit?: boolean },
	) {
		const claimed: PeerLinkEnvelope[] = [];
		for (const row of this.outbox) {
			if (claimed.length >= limit) break;
			if (row.status !== "pending" || (row.retryAfter ?? 0) > Date.now()) continue;
			if (
				options?.allowTransit === false &&
				(row.message.originStoreId !== this.storeId || row.message.visitedStoreIds.length !== 1)
			)
				continue;
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

	runMaintenance() {
		this.maintenanceRuns++;
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

/**
 * A wire-level model of the deployed origin/main V1 responder. It deliberately
 * parses only the historical hello fields, emits a hello_ack with no capability
 * field, and applies the old responderRelaySpoof check to every non-origin
 * envelope (including legitimate transit).
 */
function attachOriginMainV1Responder(input: PassThrough, output: PassThrough) {
	const probe: {
		helloCapabilities?: unknown;
		receivedMessages: PeerLinkEnvelope[];
		acceptedMessages: PeerLinkEnvelope[];
	} = { receivedMessages: [], acceptedMessages: [] };
	let buffer = "";
	let peerStoreId: string | undefined;
	let remoteSessions = new Set<string>();
	const writeAck = (messageId: string, status: "accepted" | "not_found", reason?: string) => {
		output.write(`${JSON.stringify({ type: "ack", messageId, status, ...(reason ? { reason } : {}) })}\n`);
	};
	const onData = (chunk: string | Buffer) => {
		buffer += chunk.toString();
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const raw = JSON.parse(line) as Record<string, unknown>;
			if (raw.type === "hello") {
				// The historical parser returned only these four fields. Unknown hello
				// properties were ignored, which makes this optional extension rollback-safe.
				peerStoreId = raw.storeId as string;
				remoteSessions = new Set(raw.sessions as string[]);
				probe.helloCapabilities = raw.capabilities;
				output.write(
					`${JSON.stringify({
						type: "hello_ack",
						protocol: 1,
						storeId: "store-old",
						sessions: ["session-old"],
					})}\n`,
				);
				continue;
			}
			if (raw.type !== "message") continue;
			const message = raw.message as PeerLinkEnvelope;
			probe.receivedMessages.push(message);
			const previousHop = message.visitedStoreIds.at(-1);
			const invalidFirstHop = message.visitedStoreIds.length === 1 && message.originStoreId !== peerStoreId;
			// This is intentionally the old unconditional responder check.
			const responderRelaySpoof = message.originStoreId !== peerStoreId;
			const unownedOriginSender = message.originStoreId === peerStoreId && !remoteSessions.has(message.sender);
			if (previousHop !== peerStoreId || invalidFirstHop || responderRelaySpoof || unownedOriginSender) {
				writeAck(message.id, "not_found", "invalid ingress ownership");
				continue;
			}
			if (message.recipient !== "session-old") {
				writeAck(message.id, "not_found");
				continue;
			}
			probe.acceptedMessages.push(message);
			writeAck(message.id, "accepted");
		}
	};
	input.on("data", onData);
	return { probe, stop: () => input.off("data", onData) };
}

describe("PeerLinkSession", () => {
	it("bounds large V1 session advertisements instead of tearing down the link", async () => {
		const sessions = Array.from(
			{ length: 5000 },
			(_, index) => `session-${index.toString().padStart(5, "0")}-${"x".repeat(32)}`,
		);
		const local = new MemoryPeerStore("store-a", sessions);
		const input = new PassThrough();
		const output = new PassThrough();
		let wire = "";
		output.on("data", (chunk) => {
			wire += chunk.toString();
		});
		const link = new PeerLinkSession({ role: "initiator", input, output, storage: local });
		try {
			const started = link.start();
			await waitFor(() => wire.includes("\n"));
			const helloLine = wire.slice(0, wire.indexOf("\n"));
			expect(Buffer.byteLength(helloLine, "utf8")).toBeLessThanOrEqual(MAX_PEER_LINK_FRAME_BYTES);
			const hello = parsePeerLinkFrame(helloLine);
			expect(hello.type).toBe("hello");
			if (hello.type !== "hello") throw new Error("expected hello frame");
			expect(hello.sessions.length).toBeLessThan(sessions.length);
			expect(hello.sessions[0]).toBe(sessions[0]);
			input.write(serializePeerLinkFrame({ type: "hello_ack", protocol: 1, storeId: "store-b", sessions: [] }));
			await started;
		} finally {
			await link.close();
		}
	});

	it("keeps transit retryable across an origin/main V1 responder while direct V1 delivery works", async () => {
		const local = new MemoryPeerStore("store-new", ["session-new"]);
		// Put transit first to prove direct-only claiming does not let an incompatible
		// head-of-queue row starve a later direct message.
		local.outbox.push({
			message: {
				...envelope("m:transit", "session-origin", "session-old", "store-origin"),
				visitedStoreIds: ["store-origin", "store-new"],
				hopsRemaining: 1,
			},
			target: "store-old",
			status: "pending",
		});
		local.outbox.push({
			message: envelope("m:direct-old", "session-new", "session-old", "store-new"),
			target: "store-old",
			status: "pending",
		});

		const toLegacy = new PassThrough();
		const fromLegacy = new PassThrough();
		const legacy = attachOriginMainV1Responder(toLegacy, fromLegacy);
		const link = new PeerLinkSession({
			role: "initiator",
			input: fromLegacy,
			output: toLegacy,
			storage: local,
			includeUnresolvedOutbound: true,
			flushIntervalMs: 5,
			sessionRefreshIntervalMs: 1_000,
		});
		try {
			await link.start();
			await waitFor(() => local.outbox[1]?.status === "forwarded");
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(legacy.probe.helloCapabilities).toEqual([PEER_LINK_CAPABILITY_GOSSIP_TRANSIT]);
			expect(legacy.probe.receivedMessages.map((message) => message.id)).toEqual(["m:direct-old"]);
			expect(legacy.probe.acceptedMessages.map((message) => message.id)).toEqual(["m:direct-old"]);
			expect(local.outbox[0]?.status).toBe("pending");
			expect(local.notFoundRequeues).toBe(0);
		} finally {
			await link.close();
			legacy.stop();
		}

		// The same durable row becomes claimable as soon as the peer upgrades and
		// advertises transit support on a fresh handshake.
		const upgradedRemote = new MemoryPeerStore("store-old", ["session-old"]);
		const upgraded = linkedSessions(local, upgradedRemote);
		try {
			await Promise.all([upgraded.responder.start(), upgraded.initiator.start()]);
			await waitFor(() => upgradedRemote.inbox.some((message) => message.id === "m:transit"));
			expect(local.outbox[0]?.status).toBe("forwarded");
		} finally {
			await Promise.all([upgraded.initiator.close(), upgraded.responder.close()]);
		}
	});

	it("runs storage maintenance while a link stays attached", async () => {
		const local = new MemoryPeerStore("store-a", ["session-a"]);
		const remote = new MemoryPeerStore("store-b", ["session-b"]);
		const initiatorToResponder = new PassThrough();
		const responderToInitiator = new PassThrough();
		const initiator = new PeerLinkSession({
			role: "initiator",
			input: responderToInitiator,
			output: initiatorToResponder,
			storage: local,
			maintenanceIntervalMs: 5,
		});
		const responder = new PeerLinkSession({
			role: "responder",
			input: initiatorToResponder,
			output: responderToInitiator,
			storage: remote,
			maintenanceIntervalMs: 5,
		});
		try {
			await Promise.all([responder.start(), initiator.start()]);
			await waitFor(() => local.maintenanceRuns > 0 && remote.maintenanceRuns > 0);
		} finally {
			await Promise.all([initiator.close(), responder.close()]);
		}
	});

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
		// First-hop spoof: origin claims to be store-a (the ingress) but the sender
		// session is not owned by store-a. Must be rejected as not_found.
		local.outbox.push({
			message: envelope("m:spoofed", "forged-session", "session-b", "store-a"),
			status: "pending",
		});
		const link = linkedSessions(local, remote);
		try {
			await Promise.all([link.responder.start(), link.initiator.start()]);
			await waitFor(() => local.notFoundRequeues >= 1);
			expect(remote.inbox).toHaveLength(0);
		} finally {
			await Promise.all([link.initiator.close(), link.responder.close()]);
		}
	});

	it("accepts a legitimate multi-hop relay whose origin differs from the ingress peer", async () => {
		// Under pure gossip a message that originated elsewhere and was relayed in via
		// the ingress peer is legitimate: the receiver trusts only the previous hop
		// (ingress), not the claimed origin. This is the core relay case that lets a
		// message reach an offline recipient across multiple hubs.
		const local = new MemoryPeerStore("store-a", ["session-a"]);
		const remote = new MemoryPeerStore("store-b", ["session-b"]);
		local.outbox.push({
			message: {
				...envelope("m:relay", "victim-session", "session-b", "store:origin"),
				visitedStoreIds: ["store:origin", "store-a"],
				hopsRemaining: 2,
			},
			status: "pending",
		});
		const link = linkedSessions(local, remote);
		try {
			await Promise.all([link.responder.start(), link.initiator.start()]);
			await waitFor(() => remote.inbox.length === 1);
			expect(remote.inbox[0]?.id).toBe("m:relay");
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
