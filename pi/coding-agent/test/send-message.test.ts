import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatPeerMessages,
	MAX_PEER_MESSAGE_BATCH_BYTES,
	MAX_PEER_MESSAGE_CONTENT_BYTES,
	SendMessageController,
	type SendMessageInput,
} from "../src/core/tools/send-message.ts";

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

	function controller(sessionId: string, deps?: { wakeForMessages?: () => void }): SendMessageController {
		return new SendMessageController({
			dbPath,
			getSessionId: () => sessionId,
			wakeForMessages: deps?.wakeForMessages,
		});
	}

	async function call(c: SendMessageController, params: SendMessageInput) {
		const def = c.createToolDefinition();
		return def.execute("call-1", params, undefined, undefined);
	}

	it("exposes an urgent peer-mailbox data plane without teammate creation", () => {
		const alice = controller("alice");
		try {
			const tool = alice.createToolDefinition();
			expect(tool.description).toContain("durable urgent plain-text message");
			expect(tool.description).toContain("Acceptance does not imply recipient consumption");
			expect(tool.description).toContain("no Agent, teammate Session, task ledger, or lifecycle authority");
			const schema = tool.parameters as unknown as {
				properties: Record<string, unknown>;
				additionalProperties: boolean;
			};
			expect(Object.keys(schema.properties).sort()).toEqual(["content", "to"]);
			expect(schema.additionalProperties).toBe(false);
		} finally {
			alice.shutdown();
		}
	});

	it("delivers a message between two sessions and drains it once", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			const res = await call(alice, { to: "bob", content: "need help on parser" });
			expect(res.details?.from).toBe("alice");
			expect(res.details?.to).toBe("bob");
			expect(res.details).toMatchObject({
				schemaVersion: 1,
				disposition: "local_mailbox",
				recipientPresence: "offline",
				wake: "unavailable",
			});
			expect(res.details?.messageId).toMatch(/^m:/);

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

	it("rejects a single message that could flood recipient context", async () => {
		const alice = controller("alice");
		try {
			await expect(
				call(alice, { to: "bob", content: "x".repeat(MAX_PEER_MESSAGE_CONTENT_BYTES + 1) }),
			).rejects.toThrow(/maximum/);
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
		// A wakeable controller advertises its (live) pid, so it reads back as online.
		const alice = controller("alice", { wakeForMessages: () => {} });
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
		const bob = controller("bob", { wakeForMessages: () => {} });
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

	it("always marks a message urgent and drains it with urgent priority", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			const res = await call(alice, { to: "bob", content: "drop everything" });
			expect(res.details?.schemaVersion).toBe(1);
			const text = res.content.map((p) => ("text" in p ? p.text : "")).join("");
			expect(text).toContain("accepted");
			const drained = bob.drainForInjection();
			expect(drained[0].priority).toBe("urgent");
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("is always urgent even when the caller passes no priority hint", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			await call(alice, { to: "bob", content: "whenever" });
			const drained = bob.drainForInjection();
			expect(drained[0].priority).toBe("urgent");
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("wakes an idle recipient through a process-specific socket capability", async () => {
		let woke = 0;
		const alice = controller("alice");
		// bob advertises a random boot-id socket rather than a reusable PID signal.
		const bob = controller("bob", { wakeForMessages: () => woke++ });
		try {
			bob.recordPresence("idle");
			const res = await call(alice, { to: "bob", content: "urgent!" });
			await new Promise((r) => setTimeout(r, 20));
			expect(res.details?.wake).toBe("signaled");
			expect(woke).toBeGreaterThan(0);
			const inspection = new MessageStore(dbPath);
			try {
				expect(inspection.getPresence("bob")?.wakePath).toMatch(/magenta-wake-/);
			} finally {
				inspection.close();
			}
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("notifies an active recipient so final-turn messages cannot become stranded", async () => {
		let notified = 0;
		const alice = controller("alice");
		const bob = controller("bob", { wakeForMessages: () => notified++ });
		try {
			bob.recordPresence("active");
			const res = await call(alice, { to: "bob", content: "arrived near agent_end" });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(res.details?.recipientPresence).toBe("active");
			expect(res.details?.wake).toBe("signaled");
			expect(notified).toBeGreaterThan(0);
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	// Regression: a freshly constructed wakeable session must advertise itself as
	// idle+online immediately, before it has ever run an agent loop. Previously
	// presence was only recorded from agent_start/turn_start/agent_end, so a session
	// that was open but had never been prompted had NO presence row and was invisible
	// to peers — an urgent message could neither see it nor wake it.
	it("advertises a wakeable session as idle+online on construction, before any loop", async () => {
		let woke = 0;
		const alice = controller("alice");
		// bob is wakeable but has NEVER called recordPresence explicitly.
		const bob = controller("bob", { wakeForMessages: () => woke++ });
		try {
			const res = await call(alice, { to: "bob", content: "urgent on a fresh session!" });
			await new Promise((r) => setTimeout(r, 20));
			const text = res.content.map((p) => ("text" in p ? p.text : "")).join("");
			// The sender sees bob as idle (not "no presence record yet") and wakes it.
			expect(text).toContain("idle");
			expect(res.details?.recipientPresence).toBe("idle");
			expect(res.details?.wake).toBe("signaled");
			expect(woke).toBeGreaterThan(0);
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	// A non-wakeable session (no wakeForMessages, e.g. signal handlers unavailable)
	// still records presence on construction, but must not advertise a pid, so peers
	// never try to signal a process that cannot handle the wake.
	it("records construction presence without a pid when not wakeable", async () => {
		const alice = controller("alice");
		const bob = controller("bob"); // no wakeForMessages => not wakeable
		try {
			const res = await call(alice, { to: "bob", content: "hi" });
			await new Promise((r) => setTimeout(r, 20));
			// Without a live pid, getPresence computes online=false, so the sender is
			// told the recipient is effectively offline and no wake is attempted.
			expect(res.details?.wake).toBe("unavailable");
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("caps a drain at 10 messages by default, delivering the backlog across drains", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			for (let i = 0; i < 12; i++) await call(alice, { to: "bob", content: `m${i}` });
			const first = bob.drainForInjection();
			expect(first).toHaveLength(10);
			const second = bob.drainForInjection();
			expect(second).toHaveLength(2);
			expect(bob.drainForInjection()).toHaveLength(0);
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("honors a custom drainCap", async () => {
		const alice = controller("alice");
		const bob = new SendMessageController({ dbPath, getSessionId: () => "bob", drainCap: 3 });
		try {
			for (let i = 0; i < 5; i++) await call(alice, { to: "bob", content: `m${i}` });
			expect(bob.drainForInjection()).toHaveLength(3);
			expect(bob.drainForInjection()).toHaveLength(2);
		} finally {
			alice.shutdown();
			bob.shutdown();
		}
	});

	it("requeues byte-budget overflow for the next drain without reordering", async () => {
		const alice = controller("alice");
		const bob = controller("bob");
		try {
			for (let index = 0; index < 3; index++) {
				await call(alice, { to: "bob", content: `${index}:${"x".repeat(12 * 1024)}` });
			}
			const first = bob.drainForInjection();
			expect(first.map((message) => message.content.slice(0, 2))).toEqual(["0:", "1:"]);
			expect(Buffer.byteLength(formatPeerMessages(first), "utf8")).toBeLessThanOrEqual(MAX_PEER_MESSAGE_BATCH_BYTES);
			const second = bob.drainForInjection();
			expect(second.map((message) => message.content.slice(0, 2))).toEqual(["2:"]);
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
		expect(one).toContain("One new message");
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

	it("defensively bounds legacy oversized mailbox rows", () => {
		const formatted = formatPeerMessages([
			{
				id: "legacy-large",
				sender: "legacy",
				content: `${"x".repeat(100_000)}LEGACY-TAIL`,
				createdAt: "2026-01-01T00:00:00Z",
			},
		]);
		expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(MAX_PEER_MESSAGE_BATCH_BYTES);
		expect(formatted).toContain("Peer message block shortened");
		expect(formatted).toContain("LEGACY-TAIL");
	});
});
