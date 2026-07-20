/**
 * Mailbox federation runs inside an authenticated SSH channel. V1 validates
 * first-hop sender ownership and route collisions. The responder accepts only
 * envelopes originated by its initiating leaf; the initiator trusts its
 * configured responder to relay one hub hop. V1 does not sign individual
 * multi-hop envelopes, so a configured hub is a trusted mailbox router,
 * equivalent to granting that SSH account access to routed mailbox traffic.
 */
export const PEER_LINK_PROTOCOL_VERSION = 1;
export const MAX_PEER_LINK_FRAME_BYTES = 64 * 1024;
export const MAX_PEER_LINK_MESSAGE_BYTES = 24 * 1024;
// Keep the V1 wire default at two hops so mixed-version peers accept normal
// envelopes. Raising this bound requires protocol capability negotiation.
export const DEFAULT_PEER_LINK_HOPS = 2;

export type PeerLinkMetadata = Record<string, unknown>;

export type PeerLinkEnvelope = {
	id: string;
	originStoreId: string;
	sender: string;
	recipient: string;
	content: string;
	createdAt: string;
	priority: "urgent" | "normal";
	metadata?: PeerLinkMetadata;
	visitedStoreIds: string[];
	hopsRemaining: number;
};

export type PeerLinkHelloFrame = {
	type: "hello" | "hello_ack";
	protocol: number;
	storeId: string;
	sessions: string[];
};

export type PeerLinkFrame =
	| PeerLinkHelloFrame
	| { type: "sessions"; sessions: string[] }
	| { type: "message"; message: PeerLinkEnvelope }
	| { type: "ack"; messageId: string; status: "accepted" | "duplicate" | "not_found"; reason?: string }
	| { type: "ping"; nonce: string }
	| { type: "pong"; nonce: string }
	| { type: "shutdown" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function parseEnvelope(value: unknown): PeerLinkEnvelope {
	if (!isRecord(value)) throw new Error("peer link message envelope must be an object");
	const {
		id,
		originStoreId,
		sender,
		recipient,
		content,
		createdAt,
		priority,
		metadata,
		visitedStoreIds,
		hopsRemaining,
	} = value;
	if (typeof id !== "string" || !id) throw new Error("peer link message requires an id");
	if (typeof originStoreId !== "string" || !originStoreId)
		throw new Error("peer link message requires an originStoreId");
	if (typeof sender !== "string" || !sender) throw new Error("peer link message requires a sender");
	if (typeof recipient !== "string" || !recipient) throw new Error("peer link message requires a recipient");
	if (typeof content !== "string" || !content) throw new Error("peer link message requires content");
	if (Buffer.byteLength(content, "utf8") > MAX_PEER_LINK_MESSAGE_BYTES)
		throw new Error(`peer link message exceeds ${MAX_PEER_LINK_MESSAGE_BYTES} bytes`);
	if (typeof createdAt !== "string" || !createdAt) throw new Error("peer link message requires createdAt");
	if (priority !== "urgent" && priority !== "normal") throw new Error("peer link message has invalid priority");
	if (metadata !== undefined && !isRecord(metadata)) throw new Error("peer link message metadata must be an object");
	if (!isStringArray(visitedStoreIds) || visitedStoreIds.length > DEFAULT_PEER_LINK_HOPS)
		throw new Error("peer link message requires bounded visitedStoreIds");
	if (
		!Number.isInteger(hopsRemaining) ||
		(hopsRemaining as number) < 0 ||
		(hopsRemaining as number) > DEFAULT_PEER_LINK_HOPS
	)
		throw new Error("peer link message has invalid hopsRemaining");
	return {
		id,
		originStoreId,
		sender,
		recipient,
		content,
		createdAt,
		priority,
		...(metadata ? { metadata } : {}),
		visitedStoreIds,
		hopsRemaining: hopsRemaining as number,
	};
}

export function parsePeerLinkFrame(line: string): PeerLinkFrame {
	if (Buffer.byteLength(line, "utf8") > MAX_PEER_LINK_FRAME_BYTES)
		throw new Error(`peer link frame exceeds ${MAX_PEER_LINK_FRAME_BYTES} bytes`);
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("peer link frame requires a type");
	switch (value.type) {
		case "hello":
		case "hello_ack":
			if (!Number.isInteger(value.protocol) || typeof value.storeId !== "string" || !value.storeId)
				throw new Error("peer link hello frame is invalid");
			if (!isStringArray(value.sessions) && !(Array.isArray(value.sessions) && value.sessions.length === 0))
				throw new Error("peer link hello sessions are invalid");
			return {
				type: value.type,
				protocol: value.protocol as number,
				storeId: value.storeId,
				sessions: value.sessions as string[],
			};
		case "sessions":
			if (!isStringArray(value.sessions) && !(Array.isArray(value.sessions) && value.sessions.length === 0))
				throw new Error("peer link sessions frame is invalid");
			return { type: "sessions", sessions: value.sessions as string[] };
		case "message":
			return { type: "message", message: parseEnvelope(value.message) };
		case "ack":
			if (typeof value.messageId !== "string" || !value.messageId)
				throw new Error("peer link ack requires messageId");
			if (value.status !== "accepted" && value.status !== "duplicate" && value.status !== "not_found")
				throw new Error("peer link ack has invalid status");
			return {
				type: "ack",
				messageId: value.messageId,
				status: value.status,
				...(typeof value.reason === "string" ? { reason: value.reason } : {}),
			};
		case "ping":
		case "pong":
			if (typeof value.nonce !== "string" || !value.nonce) throw new Error(`peer link ${value.type} requires nonce`);
			return { type: value.type, nonce: value.nonce };
		case "shutdown":
			return { type: "shutdown" };
		default:
			throw new Error(`unsupported peer link frame: ${value.type}`);
	}
}

export function serializePeerLinkFrame(frame: PeerLinkFrame): string {
	const line = JSON.stringify(frame);
	if (Buffer.byteLength(line, "utf8") > MAX_PEER_LINK_FRAME_BYTES)
		throw new Error(`peer link frame exceeds ${MAX_PEER_LINK_FRAME_BYTES} bytes`);
	return `${line}\n`;
}
