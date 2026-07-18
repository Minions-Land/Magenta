import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../_magenta/env/pi/nodejs.ts";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "../_magenta/session/pi/jsonl-storage.ts";
import { InMemorySessionStorage } from "../_magenta/session/pi/memory-storage.ts";
import { type MessageEntry, ok, type SessionMetadata } from "../_magenta/types/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type EntryIdStorage = { createEntryId(): Promise<string> };

function stubUuidTails(...configuredTails: string[]) {
	const tails = [...configuredTails];
	const fallbackTail = tails.at(-1) ?? "00000000";
	const getRandomValues = vi.fn((bytes: Uint8Array) => {
		bytes.fill(0);
		const tail = tails.shift() ?? fallbackTail;
		bytes.set(Buffer.from(tail, "hex"), bytes.length - 4);
		return bytes;
	});
	vi.stubGlobal("crypto", { getRandomValues });
	return getRandomValues;
}

function entryWithId(id: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: createUserMessage(id),
	};
}

async function createEntryIdStorage(kind: "memory" | "jsonl", existingIds: string[]): Promise<EntryIdStorage> {
	const entries = existingIds.map(entryWithId);
	if (kind === "memory") {
		return new InMemorySessionStorage({
			entries,
			metadata: { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" },
		});
	}

	const dir = createTempDir();
	const env = new NodeExecutionEnv({ cwd: dir });
	const storage = await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), {
		cwd: dir,
		sessionId: "session-1",
	});
	for (const entry of entries) await storage.appendEntry(entry);
	return storage;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("InMemorySessionStorage", () => {
	it("returns configured session metadata", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata });
		expect(await storage.getMetadata()).toEqual(metadata);
	});

	it("copies initial entries and persists leaf changes", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const initialEntries = [entry];
		const storage = new InMemorySessionStorage({ entries: initialEntries });
		initialEntries.push({ ...entry, id: "entry-2" });
		expect((await storage.getEntries()).map((storedEntry) => storedEntry.id)).toEqual(["entry-1"]);
		expect(await storage.getLeafId()).toBe("entry-1");
		await storage.setLeafId(null);
		expect(await storage.getLeafId()).toBeNull();
		expect((await storage.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: null });
	});

	it("rejects invalid leaf ids", async () => {
		const storage = new InMemorySessionStorage();
		await expect(storage.setLeafId("missing")).rejects.toThrow("Entry missing not found");
	});

	it("finds entries by type", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await storage.appendEntry({
			type: "label",
			id: "label-1",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
			targetId: "entry-1",
			label: "checkpoint",
		});
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await storage.appendEntry({
			type: "label",
			id: "label-2",
			parentId: "label-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			targetId: "entry-1",
			label: undefined,
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
	});

	it("walks paths to root", async () => {
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		const storage = new InMemorySessionStorage({ entries: [root, child] });
		expect((await storage.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
		expect(await storage.getPathToRoot(null)).toEqual([]);
	});
});

describe("JsonlSessionStorage", () => {
	it("throws for missing files when opening", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "not_found" });
	});

	it("writes the header on create", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(1);
		expect(await storage.getLeafId()).toBeNull();
		expect(await storage.getEntries()).toEqual([]);
		await storage.appendEntry({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]!).type).toBe("session");
		expect(JSON.parse(lines[1]!).id).toBe("user-1");
		expect(lines).toHaveLength(2);
	});

	it("throws for malformed session headers", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, "not json\n");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow("first line is not a valid session header");
	});

	it("throws for malformed entry lines", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		writeFileSync(filePath, `${JSON.stringify(header)}\nnot json\n${JSON.stringify(entry)}\n`);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("creates and reads session metadata from the header", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, {
			cwd: dir,
			sessionId: "session-1",
			parentSessionPath: "/tmp/parent.jsonl",
		});
		const metadata = await storage.getMetadata();
		expect(metadata).toMatchObject({
			id: "session-1",
			cwd: dir,
			path: filePath,
			parentSessionPath: "/tmp/parent.jsonl",
		});
		await storage.appendEntry({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect(await loadJsonlSessionMetadata(env, filePath)).toEqual(metadata);
	});

	it("loads existing entries and reconstructs leaf", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		await storage.appendEntry(root);
		await storage.appendEntry(child);
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLeafId()).toBe("child");
		expect((await loaded.getEntries()).map((entry) => entry.id)).toEqual(["root", "child"]);
		await loaded.setLeafId("root");
		const reloaded = await JsonlSessionStorage.open(env, filePath);
		expect(await reloaded.getLeafId()).toBe("root");
		expect((await reloaded.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: "root" });
		expect((await loaded.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
	});

	it("finds entries by type", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		await storage.appendEntry({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		await storage.appendEntry({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await storage.appendEntry({
			type: "label",
			id: "label-1",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
			targetId: "entry-1",
			label: "checkpoint",
		});
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await storage.appendEntry({
			type: "label",
			id: "label-2",
			parentId: "label-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			targetId: "entry-1",
			label: undefined,
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLabel("entry-1")).toBeUndefined();
	});

	it("reads session metadata through the line-reading filesystem operation", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const metadata = await loadJsonlSessionMetadata(
			{
				readTextLines: async () => ok([JSON.stringify(header)]),
				readTextFile: async () => {
					throw new Error("readTextFile should not be called for metadata");
				},
				writeFile: async () => ok(undefined),
				appendFile: async () => ok(undefined),
			},
			filePath,
		);
		expect(metadata).toEqual({
			id: "session-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			cwd: dir,
			path: filePath,
			parentSessionPath: undefined,
		});
	});

	it("round-trips custom metadata through create/open/load", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const metadata = { app: "test", version: 1, nested: { key: "value" } };
		const storage = await JsonlSessionStorage.create(env, filePath, {
			cwd: dir,
			sessionId: "session-1",
			metadata,
		});
		expect((await storage.getMetadata()).metadata).toEqual(metadata);
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect((await loaded.getMetadata()).metadata).toEqual(metadata);
		expect(await loadJsonlSessionMetadata(env, filePath)).toMatchObject({ metadata });
	});

	it("omits metadata from header when absent", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		expect((await storage.getMetadata()).metadata).toBeUndefined();
		const lines = readFileSync(filePath, "utf8").split("\n");
		const header = JSON.parse(lines[0]!);
		expect(header.metadata).toBeUndefined();
	});

	it("rejects non-object metadata at create time", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await expect(
			JsonlSessionStorage.create(env, filePath, {
				cwd: dir,
				sessionId: "session-1",
				metadata: null as unknown as Record<string, unknown>,
			}),
		).rejects.toThrow("metadata must be an object");
		await expect(
			JsonlSessionStorage.create(env, filePath, {
				cwd: dir,
				sessionId: "session-1",
				metadata: [] as unknown as Record<string, unknown>,
			}),
		).rejects.toThrow("metadata must be an object");
	});

	it("rejects non-object metadata when loading header", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const headerWithNull = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
			metadata: null,
		};
		writeFileSync(filePath, `${JSON.stringify(headerWithNull)}\n`);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow("metadata must be an object");

		const headerWithArray = { ...headerWithNull, metadata: ["invalid"] };
		writeFileSync(filePath, `${JSON.stringify(headerWithArray)}\n`);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow("metadata must be an object");
	});

	it("preserves unknown metadata fields without mutation", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const metadata = { unknown: "field", nested: { deep: true } };
		const storage = await JsonlSessionStorage.create(env, filePath, {
			cwd: dir,
			sessionId: "session-1",
			metadata,
		});
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect((await loaded.getMetadata()).metadata).toEqual(metadata);
	});
});

describe.each(["memory", "jsonl"] as const)("%s session entry IDs", (kind) => {
	it("uses the UUIDv7 random tail for short IDs", async () => {
		const getRandomValues = stubUuidTails("11223344");
		const storage = await createEntryIdStorage(kind, []);

		expect(await storage.createEntryId()).toBe("11223344");
		expect(getRandomValues).toHaveBeenCalledTimes(1);
	});

	it("retries short-ID collisions", async () => {
		const getRandomValues = stubUuidTails("deadbeef", "cafebabe");
		const storage = await createEntryIdStorage(kind, ["deadbeef"]);

		expect(await storage.createEntryId()).toBe("cafebabe");
		expect(getRandomValues).toHaveBeenCalledTimes(2);
	});

	it("falls back to a full UUID after 100 collisions", async () => {
		const getRandomValues = stubUuidTails("deadbeef");
		const storage = await createEntryIdStorage(kind, ["deadbeef"]);

		const id = await storage.createEntryId();
		expect(id).toMatch(UUID_V7_RE);
		expect(id).toHaveLength(36);
		expect(id.endsWith("deadbeef")).toBe(true);
		expect(getRandomValues).toHaveBeenCalledTimes(101);
	});
});
