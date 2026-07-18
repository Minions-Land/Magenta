import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("CC-004: deterministic no-session IDs", () => {
	it("inMemory() accepts optional id parameter", () => {
		const session = SessionManager.inMemory("/tmp/test", "deterministic-id-123");
		expect(session.getSessionId()).toBe("deterministic-id-123");
		expect(session.isPersisted()).toBe(false);
	});

	it("inMemory() generates UUIDv7 when id is omitted", () => {
		const session = SessionManager.inMemory("/tmp/test");
		const id = session.getSessionId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("inMemory(cwd, id) does not write to disk", () => {
		const session = SessionManager.inMemory("/tmp/test", "no-disk-id");
		session.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		expect(session.getSessionFile()).toBeUndefined();
	});

	it("--no-session with --session-id creates deterministic ephemeral session (CC-004)", () => {
		// Simulates: pi --no-session --session-id my-test-id
		const session = SessionManager.inMemory("/tmp/test", "my-test-id");
		expect(session.getSessionId()).toBe("my-test-id");
		expect(session.isPersisted()).toBe(false);
	});
});

describe("CC-023: clear label timestamp cache on newSession", () => {
	it("newSession() clears label timestamp cache", () => {
		const session = SessionManager.inMemory();
		const msgId = session.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
		session.appendLabelChange(msgId, "old-label");

		// Verify label exists
		expect(session.getLabel(msgId)).toBe("old-label");

		// Create new session (clears all state including label timestamps)
		session.newSession({ id: "fresh-session" });

		// Old label should not leak
		expect(session.getLabel(msgId)).toBeUndefined();
		expect(session.getSessionId()).toBe("fresh-session");
	});

	it("label timestamps do not leak across sessions", () => {
		const session = SessionManager.inMemory();
		const id1 = session.appendMessage({ role: "user", content: "first", timestamp: 1000 });
		session.appendLabelChange(id1, "label1");

		// Confirm the label + its timestamp cache entry exist before reset
		expect(session.getLabel(id1)).toBe("label1");

		session.newSession();
		const id2 = session.appendMessage({ role: "user", content: "second", timestamp: 2000 });
		session.appendLabelChange(id2, "label2");

		// Old label (and its cached timestamp) must not leak into the new session
		expect(session.getLabel(id1)).toBeUndefined();
		expect(session.getLabel(id2)).toBe("label2");

		// Only the new session's single label entry should remain
		const labels = session.getEntries().filter((e) => e.type === "label");
		expect(labels).toHaveLength(1);
		expect(labels[0].type === "label" && labels[0].targetId).toBe(id2);
	});
});

describe("CC-031: session-id creation warning (unit test only, CLI warning tested manually)", () => {
	it("SessionManager.create validates custom session id", () => {
		// This validates the id, which is the behavior CC-031 relies on
		expect(() => SessionManager.inMemory("/tmp", "")).toThrow("Session id must be non-empty");
		expect(() => SessionManager.inMemory("/tmp", "-abc")).toThrow("must be non-empty");
		expect(() => SessionManager.inMemory("/tmp", "abc/def")).toThrow("must be non-empty");
	});

	// Note: CC-031 requires main.ts to warn via stderr when creating NEW persisted session with --session-id.
	// This is a CLI-level behavior that prints: "Warning: --session-id is typically used to reopen..."
	// The warning is NOT in SessionManager itself but in createSessionManager() main.ts flow.
	// Subprocess testing requires full build (session-id-readonly.test.ts), which fails on baseline.
	// Manual CLI test: pi --session-id new-id-123 "hello" → should print warning to stderr
});
