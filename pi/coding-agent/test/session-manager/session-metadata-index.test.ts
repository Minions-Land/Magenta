import { lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	SESSION_FIRST_MESSAGE_MAX_BYTES,
	SESSION_METADATA_INDEX_MAX_BYTES,
	SESSION_METADATA_INDEX_NAME,
	SESSION_SEARCH_TEXT_MAX_BYTES,
	type SessionMetadataIndexRecord,
	writeSessionMetadataIndex,
} from "../../src/core/session-metadata-index.ts";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; sessionDir: string; cwd: string; sessionFile: string }> {
	const root = await mkdtemp(join(tmpdir(), "magenta-session-index-"));
	roots.push(root);
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "project");
	const sessionFile = join(sessionDir, "2026-01-01T00-00-00-000Z_session-one.jsonl");
	await mkdir(sessionDir, { recursive: true });
	return { root, sessionDir, cwd, sessionFile };
}

function sessionLines(cwd: string, userText: string): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "session-one",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({
			type: "message",
			id: "message-one",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: userText, timestamp: 1 },
		}),
		"",
	].join("\n");
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Session metadata index", () => {
	it("bounds searchable metadata and leaves an unchanged private index untouched", async () => {
		const { sessionDir, cwd, sessionFile } = await fixture();
		writeFileSync(sessionFile, sessionLines(cwd, `needle-start ${"x".repeat(180_000)} needle-end`));

		const first = await SessionManager.list(cwd, sessionDir);
		expect(first).toHaveLength(1);
		expect(Buffer.byteLength(first[0]!.firstMessage, "utf8")).toBeLessThanOrEqual(SESSION_FIRST_MESSAGE_MAX_BYTES);
		expect(Buffer.byteLength(first[0]!.allMessagesText, "utf8")).toBeLessThanOrEqual(SESSION_SEARCH_TEXT_MAX_BYTES);
		expect(first[0]!.allMessagesText).toContain("needle-start");
		expect(first[0]!.allMessagesText).toContain("needle-end");

		const indexPath = join(sessionDir, SESSION_METADATA_INDEX_NAME);
		expect(lstatSync(indexPath).mode & 0o777).toBe(0o600);
		const before = await stat(indexPath, { bigint: true });
		await expect(SessionManager.list(cwd, sessionDir)).resolves.toMatchObject([{ id: "session-one" }]);
		const after = await stat(indexPath, { bigint: true });
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
	});

	it("invalidates a cache record when an append changes the file identity", async () => {
		const { sessionDir, cwd, sessionFile } = await fixture();
		writeFileSync(sessionFile, sessionLines(cwd, "first"));
		expect((await SessionManager.list(cwd, sessionDir))[0]!.messageCount).toBe(1);

		await appendFile(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "message-two",
				parentId: "message-one",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "assistant", content: "second", timestamp: 2 },
			})}\n`,
		);
		expect((await SessionManager.list(cwd, sessionDir))[0]!.messageCount).toBe(2);
	});

	it("invalidates an equal-size in-place rewrite even when mtime is restored", async () => {
		const { sessionDir, cwd, sessionFile } = await fixture();
		writeFileSync(sessionFile, sessionLines(cwd, "first"));
		expect((await SessionManager.list(cwd, sessionDir))[0]!.firstMessage).toBe("first");
		const before = await stat(sessionFile);

		writeFileSync(sessionFile, sessionLines(cwd, "other"));
		await utimes(sessionFile, before.atime, before.mtime);
		expect((await SessionManager.list(cwd, sessionDir))[0]!.firstMessage).toBe("other");
	});

	it("selects a newest bounded subset before serializing a large index", async () => {
		const { sessionDir } = await fixture();
		const records = new Map<string, SessionMetadataIndexRecord>();
		for (let index = 0; index < 160; index++) {
			records.set(`2026-01-01T00-00-${String(index).padStart(3, "0")}Z_${index}.jsonl`, {
				identity: {
					device: "1",
					inode: String(index + 1),
					size: "1",
					mtimeNs: String(index + 1),
					ctimeNs: String(index + 1),
				},
				metadata: {
					id: String(index),
					cwd: "/tmp",
					created: "2026-01-01T00:00:00.000Z",
					modified: "2026-01-01T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "first",
					allMessagesText: "x".repeat(SESSION_SEARCH_TEXT_MAX_BYTES),
				},
			});
		}

		await writeSessionMetadataIndex(sessionDir, records, true);
		const indexBytes = await readFile(join(sessionDir, SESSION_METADATA_INDEX_NAME));
		expect(indexBytes.byteLength).toBeLessThanOrEqual(SESSION_METADATA_INDEX_MAX_BYTES);
		const parsed = JSON.parse(indexBytes.toString("utf8")) as { entries: Record<string, unknown> };
		expect(Object.keys(parsed.entries).length).toBeGreaterThan(0);
		expect(Object.keys(parsed.entries).length).toBeLessThan(records.size);
		expect(parsed.entries["2026-01-01T00-00-159Z_159.jsonl"]).toBeDefined();
	});

	it("never follows or replaces a symbolic-link index", async () => {
		const { root, sessionDir, cwd, sessionFile } = await fixture();
		writeFileSync(sessionFile, sessionLines(cwd, "searchable"));
		const indexPath = join(sessionDir, SESSION_METADATA_INDEX_NAME);
		const external = join(root, "external-index.json");
		writeFileSync(external, "preserve external bytes\n");
		symlinkSync(external, indexPath);

		await expect(SessionManager.list(cwd, sessionDir)).resolves.toMatchObject([{ id: "session-one" }]);
		await expect(readFile(external, "utf8")).resolves.toBe("preserve external bytes\n");
	});
});
