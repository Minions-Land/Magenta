import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

function messageEntry(message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

describe("lax message content handling", () => {
	it("normalizes null content in message_end extension replacements", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role !== "assistant") return undefined;
					return { message: { ...event.message, content: null } as unknown as AgentMessage };
				});
			},
		];
		const harness = await createHarness({ extensionFactories });
		try {
			harness.setResponses([fauxAssistantMessage("hello")]);
			await harness.session.prompt("hi");
			const assistant = harness.session.messages.find((message) => message.role === "assistant");
			expect(assistant?.content).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null content in custom messages from extensions", async () => {
		const harness = await createHarness();
		try {
			await harness.session.sendCustomMessage({
				customType: "test",
				content: null as unknown as string,
				display: false,
				details: undefined,
			});
			const custom = harness.session.messages.find((message) => message.role === "custom");
			expect(custom?.content).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null or missing content while projecting session message entries", () => {
		for (const badMessage of [
			{ role: "user", content: null, timestamp: Date.now() },
			{ role: "assistant", content: null, provider: "test", model: "test", timestamp: Date.now() },
			{ role: "toolResult", toolCallId: "call", toolName: "test", timestamp: Date.now() },
		]) {
			const context = buildSessionContext([messageEntry(badMessage)]);
			expect(context.messages[0]).toMatchObject({ role: badMessage.role, content: [] });
		}
	});

	it("normalizes null custom_message content while projecting session entries", () => {
		const entry = {
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "test",
			content: null,
			display: false,
		} as unknown as SessionEntry;
		const context = buildSessionContext([entry]);
		expect(context.messages[0]).toMatchObject({ role: "custom", content: [] });
	});
});
