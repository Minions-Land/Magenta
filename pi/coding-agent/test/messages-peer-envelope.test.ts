import { describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { PEER_MESSAGE_CUSTOM_TYPE } from "../src/core/tools/send-message.ts";

/**
 * Peer messages arrive as custom messages and must be framed so the model does
 * not mistake a teammate's message for the human user's. The wire role stays
 * "user" (provider protocol allows no custom role), but convertToLlm wraps the
 * content in a <peer-agent-message> envelope that names the provenance.
 */
describe("convertToLlm peer-message envelope", () => {
	const peerContent =
		"📨 You have a new message from a teammate agent:\n" +
		"— from session 019f597f-dfd4-73a5-9cd4-89651281583b (sent 2026-07-13T03:21:20Z, sender currently active):\n" +
		"Rebuilding harness dist now.";

	function peerMessage(content: CustomMessage["content"]): CustomMessage {
		return {
			role: "custom",
			customType: PEER_MESSAGE_CUSTOM_TYPE,
			content,
			display: true,
			timestamp: Date.now(),
		};
	}

	it("wraps string peer content in the envelope while keeping the user role", () => {
		const [msg] = convertToLlm([peerMessage(peerContent)]);
		expect(msg.role).toBe("user");
		const text = (msg.content as { type: string; text: string }[])[0].text;
		expect(text.startsWith("<peer-agent-message>")).toBe(true);
		expect(text.endsWith("</peer-agent-message>")).toBe(true);
		expect(text).toContain("NOT by the human user");
		expect(text).toContain("send_message");
		// Original sender/provenance text is preserved inside the envelope.
		expect(text).toContain("019f597f-dfd4-73a5-9cd4-89651281583b");
		expect(text).toContain("Rebuilding harness dist now.");
	});

	it("wraps only the first text segment and preserves image content", () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const [msg] = convertToLlm([peerMessage([{ type: "text", text: peerContent }, image])]);
		const content = msg.content as ({ type: "text"; text: string } | typeof image)[];
		expect(content).toHaveLength(2);
		expect(content[0].type).toBe("text");
		expect((content[0] as { text: string }).text).toContain("<peer-agent-message>");
		expect(content[1]).toEqual(image);
	});

	it("does not wrap ordinary (non-peer) custom messages", () => {
		const ordinary: CustomMessage = {
			role: "custom",
			customType: "some-extension-message",
			content: "plain custom content",
			display: true,
			timestamp: Date.now(),
		};
		const [msg] = convertToLlm([ordinary]);
		expect(msg.role).toBe("user");
		const text = (msg.content as { type: string; text: string }[])[0].text;
		expect(text).toBe("plain custom content");
		expect(text).not.toContain("<peer-agent-message>");
	});
});
