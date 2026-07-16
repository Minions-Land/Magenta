import type { FederatedMessageEnvelope, MessageStore, PeerMessageMetadata, PeerOutboxMessage } from "@magenta/harness";
import { DEFAULT_PEER_LINK_HOPS, type PeerLinkEnvelope, type PeerLinkMetadata } from "./peer-link-protocol.ts";
import type { PeerLinkAcceptResult, PeerLinkStorage } from "./peer-link-session.ts";

const FEDERATION_METADATA_KEY = "_magentaPeerFederation";

type FederationMetadata = {
	originStoreId: string;
	visitedStoreIds: string[];
	hopsRemaining: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitMetadata(metadata?: PeerMessageMetadata): {
	metadata?: PeerLinkMetadata;
	federation?: FederationMetadata;
} {
	if (!metadata) return {};
	const { [FEDERATION_METADATA_KEY]: rawFederation, ...publicMetadata } = metadata;
	const federation =
		isRecord(rawFederation) &&
		typeof rawFederation.originStoreId === "string" &&
		Array.isArray(rawFederation.visitedStoreIds) &&
		rawFederation.visitedStoreIds.every((entry) => typeof entry === "string") &&
		Number.isInteger(rawFederation.hopsRemaining)
			? {
					originStoreId: rawFederation.originStoreId,
					visitedStoreIds: rawFederation.visitedStoreIds as string[],
					hopsRemaining: rawFederation.hopsRemaining as number,
				}
			: undefined;
	return {
		...(Object.keys(publicMetadata).length > 0 ? { metadata: publicMetadata } : {}),
		...(federation ? { federation } : {}),
	};
}

function joinMetadata(metadata: PeerLinkMetadata | undefined, federation: FederationMetadata): PeerMessageMetadata {
	return {
		...(metadata ?? {}),
		[FEDERATION_METADATA_KEY]: federation,
	};
}

function toLinkEnvelope(row: PeerOutboxMessage, localStoreId: string): PeerLinkEnvelope {
	const { metadata, federation } = splitMetadata(row.metadata);
	return {
		id: row.id,
		originStoreId: federation?.originStoreId ?? localStoreId,
		sender: row.sender,
		recipient: row.recipient,
		content: row.content,
		createdAt: row.createdAt,
		priority: row.priority,
		...(metadata ? { metadata } : {}),
		visitedStoreIds: federation?.visitedStoreIds ?? [localStoreId],
		hopsRemaining: federation?.hopsRemaining ?? DEFAULT_PEER_LINK_HOPS,
	};
}

function toStoredEnvelope(message: PeerLinkEnvelope): FederatedMessageEnvelope {
	return {
		id: message.id,
		sender: message.sender,
		recipient: message.recipient,
		content: message.content,
		createdAt: message.createdAt,
		priority: message.priority,
		metadata: joinMetadata(message.metadata, {
			originStoreId: message.originStoreId,
			visitedStoreIds: message.visitedStoreIds,
			hopsRemaining: message.hopsRemaining,
		}),
	};
}

export class MessageStorePeerLinkAdapter implements PeerLinkStorage {
	readonly store: MessageStore;

	constructor(store: MessageStore) {
		this.store = store;
	}

	getStoreId(): string {
		return this.store.getStoreId();
	}

	listRegisteredSessionIds(): string[] {
		return this.store.listRegisteredSessionIds();
	}

	replacePeerRoutes(peerStoreId: string, sessionIds: string[]): void {
		this.store.replacePeerRoutes(peerStoreId, sessionIds);
	}

	claimOutbound(peerStoreId: string, ownerId: string, includeUnresolved: boolean, limit: number): PeerLinkEnvelope[] {
		return this.store
			.claimPeerOutbox(peerStoreId, ownerId, limit, includeUnresolved)
			.map((row) => toLinkEnvelope(row, this.store.getStoreId()));
	}

	ackOutbound(messageIds: string[], ownerId: string): void {
		this.store.ackPeerOutbox(messageIds, ownerId);
	}

	requeueOutbound(messageIds: string[], ownerId: string, options?: { notFound?: boolean }): void {
		this.store.requeuePeerOutbox(messageIds, ownerId, options);
	}

	acceptIncoming(message: PeerLinkEnvelope, ingressPeerStoreId: string): PeerLinkAcceptResult {
		const local = this.store.listRegisteredSessionIds().includes(message.recipient);
		if (!local && message.hopsRemaining === 0) return { status: "not_found" };
		const accepted = this.store.acceptFederatedMessage(toStoredEnvelope(message), ingressPeerStoreId);
		switch (accepted.disposition) {
			case "local":
				return { status: "accepted", localRecipient: message.recipient };
			case "relay":
				return { status: "accepted" };
			case "duplicate":
				return { status: "duplicate" };
			case "not_found":
				return { status: "not_found" };
		}
	}
}
