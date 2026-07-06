import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPeerMessages, SendMessageController } from "../src/core/tools/send-message.ts";

/**
 * Magenta feature: peer messaging controller. Verifies send validation, sender
 * identity injection, fire-once drain, presence reporting, and the
 * injected-block formatting.
 */
describe("SendMessageController", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "peermsg-"));
		dbPath = join(dir, "messages.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function controller(sessionId: string): SendMessageController {
		// heartbeatMs: 0 disables the timer so tests stay deterministic.
		return new SendMessageController({ dbPath, getSessionId: () => sessionId, heartbeatMs: 0 });
	}

	async function call(c: SendMessageController, params: { to: string; content: string }) {
		const def = c.createToolDefinition();
		return def.execute("call-1", params, undefined, undefined, {} as never);
	}

	it("delivers a message between two sessions and drains it once", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			const res = await call(alice, { to: "bob", content: "need help on parser" });
			expect(res.details?.from).toBe("alice");
			expect(res.details?.to).toBe("bob");
			expect(res.details?.id).toBeTruthy();

			const drained = bob.drainForInjection();
			expect(drained).toHaveLength(1);
			expect(drained[0].sender).toBe("alice");
			expect(drained[0].content).toBe("need help on parser");
			// Fire-once.
			expect(bob.drainForInjection()).toHaveLength(0);
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("rejects self-messaging", async () => {
		const alice = controller("alice");
		try {
			await expect(call(alice, { to: "alice", content: "hi me" })).rejects.toThrow();
		} finally {
			alice.shutdown();
		}
	});

	it("rejects empty recipient or content", async () => {
		const alice = controller("alice");
		try {
			await expect(call(alice, { to: "", content: "x" })).rejects.toThrow();
			await expect(call(alice, { to: "bob", content: "  " })).rejects.toThrow();
		} finally {
			alice.shutdown();
		}
	});

	it("only delivers to the addressed recipient", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		const carol = controller("carol");
		try {
			await call(alice, { to: "bob", content: "for bob" });
			expect(carol.drainForInjection()).toHaveLength(0);
			expect(bob.drainForInjection()).toHaveLength(1);
		} finally {
			alice.shutdown();
			bob.shutdown();
			carol.shutdown();
		}
	});

	it("attaches sender presence to drained messages", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			alice.recordPresence("active");
			await call(alice, { to: "bob", content: "ping" });
			const drained = bob.drainForInjection();
			expect(drained[0].senderPresence?.state).toBe("active");
			expect(drained[0].senderPresence?.online).toBe(true);
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("reports recipient presence back to the sender in the result text", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			bob.recordPresence("idle");
			const res = await call(alice, { to: "bob", content: "hi" });
			const text = res.content.map((p) => ("text" in p ? p.text : "")).join("");
			expect(text).toContain("idle");
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("formats a single message and multiple messages distinctly", () => {
		const one = formatPeerMessages([
			{
				id: "m1",
				sender: "alice",
				content: "hello",
				createdAt: "2026-01-01T00:00:00Z",
				senderPresence: { state: "active", lastSeen: "2026-01-01T00:00:00Z", online: true },
			},
		]);
		expect(one).toContain("a new message");
		expect(one).toContain("alice");
		expect(one).toContain("hello");
		expect(one).toContain("currently active");

		const many = formatPeerMessages([
			{ id: "m1", sender: "alice", content: "one", createdAt: "2026-01-01T00:00:00Z" },
			{
				id: "m2",
				sender: "carol",
				content: "two",
				createdAt: "2026-01-01T00:00:01Z",
				senderPresence: { state: "offline", lastSeen: "2026-01-01T00:00:00Z", online: false },
			},
		]);
		expect(many).toContain("2 new messages");
		expect(many).toContain("one");
		expect(many).toContain("two");
		expect(many).toContain("presence unknown");
		expect(many).toContain("offline");

		expect(formatPeerMessages([])).toBe("");
	});
});
