import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
	MAX_PEER_LINK_FRAME_BYTES,
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
	replacePeerRoutes(peerStoreId: string, sessionIds: string[]): void;
	claimOutbound(peerStoreId: string, ownerId: string, includeUnresolved: boolean, limit: number): PeerLinkEnvelope[];
	ackOutbound(messageIds: string[], ownerId: string): void;
	requeueOutbound(messageIds: string[], ownerId: string, options?: { notFound?: boolean }): void;
	acceptIncoming(message: PeerLinkEnvelope, ingressPeerStoreId: string): PeerLinkAcceptResult;
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
	batchSize?: number;
	onLocalRecipient?: (sessionId: string) => void;
	onState?: (state: "handshaking" | "ready" | "closed" | "failed", error?: string) => void;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_SESSION_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 50;

export class PeerLinkSession {
	private readonly ownerId = randomUUID();
	private readonly localStoreId: string;
	private peerStoreId?: string;
	private remoteSessions = new Set<string>();
	private started = false;
	private ready = false;
	private closed = false;
	private stopReading?: () => void;
	private handshakeTimer?: NodeJS.Timeout;
	private flushTimer?: NodeJS.Timeout;
	private sessionTimer?: NodeJS.Timeout;
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
		const sessions = this.options.storage.listRegisteredSessionIds().sort();
		this.lastAdvertisedSessions = JSON.stringify(sessions);
		return { type, protocol: PEER_LINK_PROTOCOL_VERSION, storeId: this.localStoreId, sessions };
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
					this.options.storage.ackOutbound([frame.messageId], this.ownerId);
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
		await this.flush();
	}

	private replaceRemoteSessions(peerStoreId: string, sessionIds: string[]): void {
		const localSessions = new Set(this.options.storage.listRegisteredSessionIds());
		const collision = sessionIds.find((sessionId) => localSessions.has(sessionId));
		if (collision) throw new Error(`peer attempted to advertise local session ${collision}`);
		this.remoteSessions = new Set(sessionIds);
		this.options.storage.replacePeerRoutes(peerStoreId, sessionIds);
	}

	private async handleMessage(message: PeerLinkEnvelope): Promise<void> {
		const ingressStoreId = this.peerStoreId!;
		const previousHop = message.visitedStoreIds.at(-1);
		const invalidFirstHop = message.visitedStoreIds.length === 1 && message.originStoreId !== ingressStoreId;
		const responderRelaySpoof = this.options.role === "responder" && message.originStoreId !== ingressStoreId;
		const unownedOriginSender = message.originStoreId === ingressStoreId && !this.remoteSessions.has(message.sender);
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
		if (!this.isReady) return;
		const sessions = this.options.storage.listRegisteredSessionIds().sort();
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
		this.handshakeTimer = undefined;
		this.flushTimer = undefined;
		this.sessionTimer = undefined;
		this.stopReading?.();
		this.stopReading = undefined;
		this.options.input.off("end", this.onInputEnd);
		this.options.input.off("error", this.onInputError);
		this.options.output.off("error", this.onOutputError);
	}
}
