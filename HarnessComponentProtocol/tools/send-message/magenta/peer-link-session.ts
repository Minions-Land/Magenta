import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
	MAX_PEER_LINK_FRAME_BYTES,
	PEER_LINK_CAPABILITY_DURABLE_CUSTODY,
	PEER_LINK_CAPABILITY_GOSSIP_TRANSIT,
	PEER_LINK_PROTOCOL_VERSION,
	type PeerLinkEnvelope,
	type PeerLinkFrame,
	parsePeerLinkFrame,
	serializePeerLinkFrame,
} from "./peer-link-protocol.ts";

export type PeerLinkAcceptResult = {
	status: "accepted" | "duplicate" | "not_found";
	localRecipient?: string;
};

export type PeerLinkStorage = {
	getStoreId(): string;
	listRegisteredSessionIds(): string[];
	listAdvertisableSessions(excludePeerStoreId?: string): string[];
	replacePeerRoutes(peerStoreId: string, sessionIds: string[]): void;
	claimOutbound(
		peerStoreId: string,
		ownerId: string,
		includeUnresolved: boolean,
		limit: number,
		options?: { allowTransit?: boolean; reclaimUnsettledForwarded?: boolean },
	): PeerLinkEnvelope[];
	ackOutbound(messageIds: string[], ownerId: string, options: { durableCustody: boolean }): void;
	requeueOutbound(messageIds: string[], ownerId: string, options?: { notFound?: boolean }): void;
	acceptIncoming(message: PeerLinkEnvelope, ingressPeerStoreId: string): PeerLinkAcceptResult;
	runMaintenance?(): void;
};

export type PeerLinkSessionOptions = {
	role: "initiator" | "responder";
	input: Readable;
	output: Writable;
	storage: PeerLinkStorage;
	includeUnresolvedOutbound?: boolean;
	handshakeTimeoutMs?: number;
	flushIntervalMs?: number;
	sessionRefreshIntervalMs?: number;
	maintenanceIntervalMs?: number;
	batchSize?: number;
	onLocalRecipient?: (sessionId: string) => void;
	onState?: (state: "handshaking" | "ready" | "closed" | "failed", error?: string) => void;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_SESSION_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 50;
const LOCAL_CAPABILITIES = [PEER_LINK_CAPABILITY_GOSSIP_TRANSIT, PEER_LINK_CAPABILITY_DURABLE_CUSTODY];

export class PeerLinkSession {
	private readonly ownerId = randomUUID();
	private readonly localStoreId: string;
	private peerStoreId?: string;
	private remoteSessions = new Set<string>();
	private remoteCapabilities = new Set<string>();
	private started = false;
	private ready = false;
	private closed = false;
	private stopReading?: () => void;
	private handshakeTimer?: NodeJS.Timeout;
	private flushTimer?: NodeJS.Timeout;
	private sessionTimer?: NodeJS.Timeout;
	private maintenanceTimer?: NodeJS.Timeout;
	private processing = Promise.resolve();
	private writing = Promise.resolve();
	private inFlight = new Set<string>();
	private flushRunning = false;
	private flushRequested = false;
	private lastAdvertisedSessions = "";
	private startResolve?: () => void;
	private startReject?: (error: Error) => void;
	private readonly options: PeerLinkSessionOptions;

	constructor(options: PeerLinkSessionOptions) {
		this.options = options;
		this.localStoreId = options.storage.getStoreId();
	}

	get remoteStoreId(): string | undefined {
		return this.peerStoreId;
	}

	get isReady(): boolean {
		return this.ready && !this.closed;
	}

	start(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("peer link session is closed"));
		if (this.started) return Promise.reject(new Error("peer link session is already started"));
		this.started = true;
		this.options.onState?.("handshaking");
		this.stopReading = this.attachBoundedJsonlReader(this.options.input);
		this.options.input.once("end", this.onInputEnd);
		this.options.input.once("error", this.onInputError);
		this.options.output.once("error", this.onOutputError);
		const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.handshakeTimer = setTimeout(() => this.fail(new Error("peer link handshake timed out")), timeoutMs);
		const started = new Promise<void>((resolve, reject) => {
			this.startResolve = resolve;
			this.startReject = reject;
		});
		if (this.options.role === "initiator")
			void this.writeFrame(this.helloFrame("hello")).catch((error) => this.fail(error));
		return started;
	}

	async flush(): Promise<void> {
		if (!this.isReady || !this.peerStoreId) return;
		const remoteAllowsTransit = this.remoteCapabilities.has(PEER_LINK_CAPABILITY_GOSSIP_TRANSIT);
		const remoteProvidesDurableCustody = this.remoteCapabilities.has(PEER_LINK_CAPABILITY_DURABLE_CUSTODY);
		// The previous gossip release accepted transit but expired it by receipt age.
		// Do not create a per-link claim until that peer can prove durable custody.
		if (remoteAllowsTransit && !remoteProvidesDurableCustody) return;
		if (this.flushRunning) {
			this.flushRequested = true;
			return;
		}
		this.flushRunning = true;
		try {
			do {
				this.flushRequested = false;
				const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
				const available = batchSize - this.inFlight.size;
				if (available <= 0) return;
				const batch = this.options.storage.claimOutbound(
					this.peerStoreId,
					this.ownerId,
					this.options.includeUnresolvedOutbound === true,
					available,
					{
						allowTransit: remoteAllowsTransit,
						reclaimUnsettledForwarded: remoteProvidesDurableCustody,
					},
				);
				if (batch.length === 0) return;
				// Claiming is atomic for the whole batch. Track every row before the
				// first write so any partial transport failure requeues the full suffix.
				for (const message of batch) this.inFlight.add(message.id);
				for (const message of batch) {
					if (!this.inFlight.has(message.id)) continue;
					await this.writeFrame({ type: "message", message });
				}
			} while (this.flushRequested && this.isReady);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			throw error;
		} finally {
			this.flushRunning = false;
		}
	}

	async close(sendShutdown = false): Promise<void> {
		if (this.closed) return;
		if (sendShutdown && this.ready) await this.writeFrame({ type: "shutdown" }).catch(() => undefined);
		this.closed = true;
		this.ready = false;
		this.cleanup();
		if (this.inFlight.size > 0) {
			this.options.storage.requeueOutbound([...this.inFlight], this.ownerId);
			this.inFlight.clear();
		}
		this.options.onState?.("closed");
	}

	private readonly onInputEnd = () => this.fail(new Error("peer link input closed"));
	private readonly onInputError = (error: Error) => this.fail(error);
	private readonly onOutputError = (error: Error) => this.fail(error);

	private helloFrame(type: "hello" | "hello_ack"): PeerLinkFrame {
		const sessions = this.fitSessionsToFrame(type, this.options.storage.listRegisteredSessionIds());
		this.lastAdvertisedSessions = JSON.stringify(sessions);
		return {
			type,
			protocol: PEER_LINK_PROTOCOL_VERSION,
			storeId: this.localStoreId,
			sessions,
			capabilities: LOCAL_CAPABILITIES,
		};
	}

	private fitSessionsToFrame(type: "hello" | "hello_ack" | "sessions", sessions: string[]): string[] {
		const unique = [...new Set(sessions)];
		const frameFor = (candidate: string[]): PeerLinkFrame =>
			type === "sessions"
				? { type, sessions: candidate }
				: {
						type,
						protocol: PEER_LINK_PROTOCOL_VERSION,
						storeId: this.localStoreId,
						sessions: candidate,
						capabilities: LOCAL_CAPABILITIES,
					};
		let lower = 0;
		let upper = unique.length;
		while (lower < upper) {
			const middle = Math.ceil((lower + upper) / 2);
			const bytes = Buffer.byteLength(JSON.stringify(frameFor(unique.slice(0, middle))), "utf8");
			if (bytes <= MAX_PEER_LINK_FRAME_BYTES) lower = middle;
			else upper = middle - 1;
		}
		return unique.slice(0, lower);
	}

	private attachBoundedJsonlReader(stream: Readable): () => void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const onData = (chunk: string | Buffer) => {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			if (Buffer.byteLength(buffer, "utf8") > MAX_PEER_LINK_FRAME_BYTES && !buffer.includes("\n")) {
				this.fail(new Error(`peer link frame exceeds ${MAX_PEER_LINK_FRAME_BYTES} bytes`));
				return;
			}
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line) this.enqueueLine(line);
			}
		};
		const onEnd = () => {
			buffer += decoder.end();
			if (buffer) this.enqueueLine(buffer.replace(/\r$/, ""));
		};
		stream.on("data", onData);
		stream.on("end", onEnd);
		return () => {
			stream.off("data", onData);
			stream.off("end", onEnd);
		};
	}

	private enqueueLine(line: string): void {
		this.processing = this.processing
			.then(() => this.handleFrame(parsePeerLinkFrame(line)))
			.catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
	}

	private async handleFrame(frame: PeerLinkFrame): Promise<void> {
		if (this.closed) return;
		if (!this.ready) {
			await this.handleHandshake(frame);
			return;
		}
		switch (frame.type) {
			case "hello":
			case "hello_ack":
				throw new Error("unexpected peer link handshake frame after ready");
			case "sessions":
				this.replaceRemoteSessions(this.peerStoreId!, frame.sessions);
				return;
			case "message":
				await this.handleMessage(frame.message);
				return;
			case "ack":
				if (!this.inFlight.delete(frame.messageId)) return;
				if (frame.status === "accepted" || frame.status === "duplicate") {
					this.options.storage.ackOutbound([frame.messageId], this.ownerId, {
						// Pre-gossip V1 accepted only a locally-owned recipient into its
						// durable inbox. The unsafe mixed-version case is transit-only V1.
						durableCustody:
							!this.remoteCapabilities.has(PEER_LINK_CAPABILITY_GOSSIP_TRANSIT) ||
							this.remoteCapabilities.has(PEER_LINK_CAPABILITY_DURABLE_CUSTODY),
					});
				} else {
					this.options.storage.requeueOutbound([frame.messageId], this.ownerId, { notFound: true });
				}
				void this.flush().catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
				return;
			case "ping":
				await this.writeFrame({ type: "pong", nonce: frame.nonce });
				return;
			case "pong":
				return;
			case "shutdown":
				await this.close(false);
		}
	}

	private async handleHandshake(frame: PeerLinkFrame): Promise<void> {
		const expected = this.options.role === "initiator" ? "hello_ack" : "hello";
		if (frame.type !== expected) throw new Error(`expected peer link ${expected} frame`);
		if (frame.protocol !== PEER_LINK_PROTOCOL_VERSION)
			throw new Error(`peer link protocol mismatch: local=${PEER_LINK_PROTOCOL_VERSION} remote=${frame.protocol}`);
		if (frame.storeId === this.localStoreId) throw new Error("peer link cannot connect a mailbox store to itself");
		this.peerStoreId = frame.storeId;
		this.remoteCapabilities = new Set(frame.capabilities ?? []);
		this.replaceRemoteSessions(frame.storeId, frame.sessions);
		if (this.options.role === "responder") await this.writeFrame(this.helloFrame("hello_ack"));
		this.ready = true;
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
		this.startResolve?.();
		this.startResolve = undefined;
		this.startReject = undefined;
		this.options.onState?.("ready");
		this.flushTimer = setInterval(
			() => void this.flush().catch((error) => this.fail(error)),
			this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
		);
		this.sessionTimer = setInterval(
			() => void this.advertiseSessions().catch((error) => this.fail(error)),
			this.options.sessionRefreshIntervalMs ?? DEFAULT_SESSION_REFRESH_INTERVAL_MS,
		);
		if (this.options.storage.runMaintenance) {
			this.maintenanceTimer = setInterval(() => {
				try {
					this.options.storage.runMaintenance?.();
				} catch (error) {
					this.fail(error instanceof Error ? error : new Error(String(error)));
				}
			}, this.options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS);
		}
		await this.flush();
	}

	private replaceRemoteSessions(peerStoreId: string, sessionIds: string[]): void {
		// A peer may advertise sessions reachable through it, which can transitively
		// include our own local sessions (reflected back via a relay hub). Local
		// sessions must always resolve locally, so filter them out of remote routes
		// rather than treating the reflection as a spoofing attempt.
		const localSessions = new Set(this.options.storage.listRegisteredSessionIds());
		const remoteSessionIds = sessionIds.filter((sessionId) => !localSessions.has(sessionId));
		this.remoteSessions = new Set(remoteSessionIds);
		this.options.storage.replacePeerRoutes(peerStoreId, remoteSessionIds);
	}

	private async handleMessage(message: PeerLinkEnvelope): Promise<void> {
		const ingressStoreId = this.peerStoreId!;
		const previousHop = message.visitedStoreIds.at(-1);
		const isFirstHop = message.visitedStoreIds.length === 1;
		const invalidFirstHop = isFirstHop && message.originStoreId !== ingressStoreId;
		// First-hop ownership: a leaf may only originate messages it owns. On later
		// hops (gossip relay) origin != ingress is expected and must be allowed.
		const responderRelaySpoof =
			this.options.role === "responder" && isFirstHop && message.originStoreId !== ingressStoreId;
		const unownedOriginSender =
			isFirstHop && message.originStoreId === ingressStoreId && !this.remoteSessions.has(message.sender);
		if (previousHop !== ingressStoreId || invalidFirstHop || responderRelaySpoof || unownedOriginSender) {
			await this.writeFrame({
				type: "ack",
				messageId: message.id,
				status: "not_found",
				reason: "invalid ingress ownership",
			});
			return;
		}
		if (message.visitedStoreIds.includes(this.localStoreId)) {
			await this.writeFrame({ type: "ack", messageId: message.id, status: "not_found", reason: "routing loop" });
			return;
		}
		const received: PeerLinkEnvelope = {
			...message,
			visitedStoreIds: [...message.visitedStoreIds, this.localStoreId],
			hopsRemaining: Math.max(0, message.hopsRemaining - 1),
		};
		const result = this.options.storage.acceptIncoming(received, this.peerStoreId!);
		if (result.localRecipient) this.options.onLocalRecipient?.(result.localRecipient);
		await this.writeFrame({ type: "ack", messageId: message.id, status: result.status });
	}

	private async advertiseSessions(): Promise<void> {
		if (!this.isReady || !this.peerStoreId) return;
		// Advertise local presence sessions plus sessions reachable through other
		// peers, so a peer connected only to this relay can still route to them.
		// Exclude routes owned by this peer's own store to prevent reflection loops.
		const sessions = this.fitSessionsToFrame(
			"sessions",
			this.options.storage.listAdvertisableSessions(this.peerStoreId),
		);
		const snapshot = JSON.stringify(sessions);
		if (snapshot === this.lastAdvertisedSessions) return;
		this.lastAdvertisedSessions = snapshot;
		await this.writeFrame({ type: "sessions", sessions });
	}

	private writeFrame(frame: PeerLinkFrame): Promise<void> {
		const line = serializePeerLinkFrame(frame);
		const write = this.writing.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (this.closed) {
						reject(new Error("peer link session is closed"));
						return;
					}
					const onError = (error: Error) => {
						this.options.output.off("drain", onDrain);
						reject(error);
					};
					const onDrain = () => {
						this.options.output.off("error", onError);
						resolve();
					};
					this.options.output.once("error", onError);
					try {
						if (this.options.output.write(line)) {
							this.options.output.off("error", onError);
							resolve();
						} else {
							this.options.output.once("drain", onDrain);
						}
					} catch (error) {
						this.options.output.off("error", onError);
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				}),
		);
		this.writing = write.catch(() => undefined);
		return write;
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.ready = false;
		this.cleanup();
		if (this.inFlight.size > 0) {
			this.options.storage.requeueOutbound([...this.inFlight], this.ownerId);
			this.inFlight.clear();
		}
		this.startReject?.(error);
		this.startResolve = undefined;
		this.startReject = undefined;
		this.options.onState?.("failed", error.message);
	}

	private cleanup(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		if (this.flushTimer) clearInterval(this.flushTimer);
		if (this.sessionTimer) clearInterval(this.sessionTimer);
		if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
		this.handshakeTimer = undefined;
		this.flushTimer = undefined;
		this.sessionTimer = undefined;
		this.maintenanceTimer = undefined;
		this.stopReading?.();
		this.stopReading = undefined;
		this.options.input.off("end", this.onInputEnd);
		this.options.input.off("error", this.onInputError);
		this.options.output.off("error", this.onOutputError);
	}
}
