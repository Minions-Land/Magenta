import { describe, expect, it } from "vitest";
import {
	MAX_PEER_LINK_FRAME_BYTES,
	type PeerLinkFrame,
	parsePeerLinkFrame,
	serializePeerLinkFrame,
} from "../../tools/send-message/magenta/peer-link-protocol.ts";

describe("peer link protocol", () => {
	it("round-trips hello, message, and ack frames", () => {
		const frames: PeerLinkFrame[] = [
			{ type: "hello", protocol: 1, storeId: "store-a", sessions: ["session-a"] },
			{
				type: "message",
				message: {
					id: "m:1",
					originStoreId: "store-a",
					sender: "session-a",
					recipient: "session-b",
					content: "hello",
					createdAt: "2026-07-16T00:00:00.000Z",
					priority: "urgent",
					metadata: { routeTag: "route-1" },
					visitedStoreIds: ["store-a"],
					hopsRemaining: 2,
				},
			},
			{ type: "ack", messageId: "m:1", status: "accepted" },
		];

		for (const frame of frames) {
			const line = serializePeerLinkFrame(frame);
			expect(parsePeerLinkFrame(line.trimEnd())).toEqual(frame);
		}
	});

	it("rejects malformed, oversized, and over-hop message frames", () => {
		expect(() => parsePeerLinkFrame('{"type":"ack"}')).toThrow(/messageId/);
		expect(() => parsePeerLinkFrame("x".repeat(MAX_PEER_LINK_FRAME_BYTES + 1))).toThrow(/exceeds/);
		expect(() =>
			parsePeerLinkFrame(
				JSON.stringify({
					type: "message",
					message: {
						id: "m:1",
						originStoreId: "store-a",
						sender: "a",
						recipient: "b",
						content: "hello",
						createdAt: "now",
						priority: "urgent",
						visitedStoreIds: ["store-a"],
						hopsRemaining: -1,
					},
				}),
			),
		).toThrow(/hopsRemaining/);
		expect(() =>
			parsePeerLinkFrame(
				JSON.stringify({
					type: "message",
					message: {
						id: "m:2",
						originStoreId: "store-a",
						sender: "a",
						recipient: "b",
						content: "hello",
						createdAt: "now",
						priority: "urgent",
						visitedStoreIds: ["store-a"],
						hopsRemaining: 3,
					},
				}),
			),
		).toThrow(/hopsRemaining/);
	});
});
