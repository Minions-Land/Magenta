import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-withdraw-message-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager.withdrawUserMessage", () => {
	it("removes only the exact user entry and reparents every direct child", () => {
		const session = SessionManager.inMemory();
		const oldParentId = session.appendMessage(assistantMsg("existing"));
		const withdrawnId = session.appendMessage(userMsg("withdraw me"));
		const firstChildId = session.appendCustomEntry("concurrent", { order: 1 });
		session.branch(withdrawnId);
		const secondChildId = session.appendCustomEntry("concurrent", { order: 2 });

		expect(session.withdrawUserMessage(withdrawnId)).toBe(true);
		expect(session.getEntry(withdrawnId)).toBeUndefined();
		expect(session.getEntry(firstChildId)?.parentId).toBe(oldParentId);
		expect(session.getEntry(secondChildId)?.parentId).toBe(oldParentId);
		expect(session.getLeafId()).toBe(secondChildId);
		expect(session.buildSessionContext().messages.map((message) => message.role)).toEqual(["assistant"]);
	});

	it("removes exact persisted assistant entries while retaining their other descendants", () => {
		const session = SessionManager.inMemory();
		const oldParentId = session.appendMessage(assistantMsg("existing"));
		const withdrawnId = session.appendMessage(userMsg("withdraw me"));
		const emptyAssistantId = session.appendMessage(assistantMsg(""));
		const retainedChildId = session.appendCustomEntry("concurrent", { retained: true });

		expect(session.withdrawUserMessage(withdrawnId, [emptyAssistantId])).toBe(true);
		expect(session.getEntry(withdrawnId)).toBeUndefined();
		expect(session.getEntry(emptyAssistantId)).toBeUndefined();
		expect(session.getEntry(retainedChildId)?.parentId).toBe(oldParentId);
		expect(session.getLeafId()).toBe(retainedChildId);
	});

	it("restores the old parent as leaf when the withdrawn user was the leaf", () => {
		const session = SessionManager.inMemory();
		const unrelatedRoot = session.appendMessage(userMsg("old branch"));
		const unrelatedLeaf = session.appendMessage(assistantMsg("old branch response"));
		session.branch(unrelatedRoot);
		const oldParentId = session.appendCustomEntry("active-branch");
		const withdrawnId = session.appendMessage(userMsg("withdraw me"));

		expect(session.withdrawUserMessage(withdrawnId)).toBe(true);
		expect(session.getLeafId()).toBe(oldParentId);
		expect(session.getLeafId()).not.toBe(unrelatedLeaf);
	});

	it("rewrites an already-persisted JSONL without the target entry", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, dir);
		session.appendMessage(userMsg("seed"));
		const oldParentId = session.appendMessage(assistantMsg("seed response"));
		const withdrawnId = session.appendMessage(userMsg("withdraw me"));
		const emptyAssistantId = session.appendMessage(assistantMsg(""));
		const childId = session.appendCustomEntry("concurrent");
		const file = session.getSessionFile()!;
		expect(existsSync(file)).toBe(true);

		expect(session.withdrawUserMessage(withdrawnId, [emptyAssistantId])).toBe(true);

		const entries = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string; parentId?: string | null });
		expect(entries.some((entry) => entry.id === withdrawnId)).toBe(false);
		expect(entries.some((entry) => entry.id === emptyAssistantId)).toBe(false);
		expect(entries.find((entry) => entry.id === childId)?.parentId).toBe(oldParentId);
	});

	it("does not create a session file when the first prompt was never flushed", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		const withdrawnId = session.appendMessage(userMsg("first prompt"));
		expect(existsSync(file)).toBe(false);

		expect(session.withdrawUserMessage(withdrawnId)).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(session.getEntries()).toEqual([]);
	});

	it("rejects assistant, custom, missing, and repeated targets", () => {
		const session = SessionManager.inMemory();
		const assistantId = session.appendMessage(assistantMsg("not user"));
		const customId = session.appendCustomEntry("not-message");
		const userId = session.appendMessage(userMsg("once"));

		expect(session.withdrawUserMessage(assistantId)).toBe(false);
		expect(session.withdrawUserMessage(customId)).toBe(false);
		expect(session.withdrawUserMessage("missing")).toBe(false);
		expect(session.withdrawUserMessage(userId)).toBe(true);
		expect(session.withdrawUserMessage(userId)).toBe(false);
	});
});
