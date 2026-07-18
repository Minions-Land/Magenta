import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore } from "../tools/send-message/magenta/message-store.ts";
import { MAX_PEER_MESSAGE_CONTENT_BYTES, SendMessageController } from "../tools/send-message/magenta/send-message.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("send_message HCP Tool", () => {
	let directory: string;
	let dbPath: string;
	const controllers: SendMessageController[] = [];

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "hcp-send-message-"));
		dbPath = join(directory, "messages.db");
	});

	afterEach(() => {
		for (const controller of controllers.splice(0)) controller.shutdown();
		rmSync(directory, { recursive: true, force: true });
	});

	function open(sessionId: string, wakeForMessages?: () => void): SendMessageController {
		const controller = new SendMessageController({ dbPath, getSessionId: () => sessionId, wakeForMessages });
		controllers.push(controller);
		return controller;
	}

	it("exposes exactly one atomic message input", () => {
		const tool = open("sender").createToolDefinition();
		const schema = tool.parameters as { properties: Record<string, unknown>; required: string[] };
		expect(Object.keys(schema.properties)).toEqual(["to", "content"]);
		expect(schema.required).toEqual(["to", "content"]);
		expect(tool.description).toContain("Acceptance does not imply recipient consumption");
	});

	it("acknowledges a committed local mailbox row without claiming consumption", async () => {
		const sender = open("sender");
		const recipient = open("recipient", () => {});
		const result = await sender
			.createToolDefinition()
			.execute("call", { to: "recipient", content: "status" }, undefined, undefined);
		expect(result.details).toMatchObject({
			schemaVersion: 1,
			from: "sender",
			to: "recipient",
			disposition: "local_mailbox",
			recipientPresence: "idle",
		});
		expect(result.details.messageId).toBeTruthy();
		expect(result.details.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(text(result)).toContain("accepted");
		expect(text(result)).not.toContain("delivered");
		const claimed = recipient.drainForInjection();
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({ sender: "sender", recipient: "recipient", priority: "urgent" });
		recipient.confirmDelivered(claimed.map((message) => message.id));
		expect(recipient.drainForInjection()).toEqual([]);
	});

	it("durably accepts an unresolved remote route", async () => {
		const sender = open("sender");
		const result = await sender
			.createToolDefinition()
			.execute("call", { to: "future-session", content: "queued" }, undefined, undefined);
		expect(result.details).toMatchObject({
			disposition: "unresolved_outbox",
			recipientPresence: "unknown",
			wake: "unavailable",
		});
		const store = new MessageStore(dbPath);
		try {
			expect(store.getPeerOutboxCounts()).toMatchObject({ pending: 1, unresolved: 1 });
		} finally {
			store.close();
		}
	});

	it("allows any known Session rather than enforcing a parent-only channel", async () => {
		const sender = open("teammate");
		const peer = open("peer");
		await expect(
			sender.createToolDefinition().execute("call", { to: "peer", content: "coordinate" }, undefined, undefined),
		).resolves.toBeDefined();
		expect(peer.drainForInjection()[0]?.sender).toBe("teammate");
	});

	it("rejects empty, self-addressed, and oversized messages", async () => {
		const sender = open("sender");
		const tool = sender.createToolDefinition();
		await expect(tool.execute("call", { to: "", content: "x" }, undefined, undefined)).rejects.toThrow();
		await expect(tool.execute("call", { to: "peer", content: " " }, undefined, undefined)).rejects.toThrow();
		await expect(tool.execute("call", { to: "sender", content: "x" }, undefined, undefined)).rejects.toThrow();
		await expect(
			tool.execute(
				"call",
				{ to: "peer", content: "x".repeat(MAX_PEER_MESSAGE_CONTENT_BYTES + 1) },
				undefined,
				undefined,
			),
		).rejects.toThrow(/maximum/);
	});
});
