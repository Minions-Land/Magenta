import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../HcpClient.ts";
import * as memoryServer from "../memory/HcpServer.ts";
import {
	SESSION_GROUNDING_STORE_MAX_BYTES,
	SessionGroundingMemoryProvider,
} from "../memory/magenta/session-grounding.ts";

describe("session grounding memory provider", () => {
	it("serves Magenta1 session-grounding memory and retains local facts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-session-grounding-"));
		const storePath = join(dir, ".magenta", "memory", "session-grounding.jsonl");
		const provider = new SessionGroundingMemoryProvider({
			workspaceRoot: dir,
			storePath,
			now: () => 42,
		});
		const source = {
			kind: "native",
			hotSwappable: false,
			toCapability: () => ({ kind: "memory", name: "memory", source: "magenta", instance: provider }),
		};
		const hcp = new HcpClient();
		hcp.registerModule(new memoryServer.HcpServer(), new Map([["memory", source]]));

		await expect(hcp.dispatch({ target: "memory://session-grounding", op: "read" })).resolves.toMatchObject({
			name: "session-grounding",
			content: expect.stringContaining("Preserve user-stated architecture boundaries"),
			entries: [],
		});

		await expect(
			hcp.dispatch({
				target: "memory://session-grounding",
				op: "retain",
				input: { text: "Use TypeScript-first migration", tags: ["migration"] },
			}),
		).resolves.toMatchObject({
			target: "memory://session-grounding",
			op: "retain",
			id: "mem-42",
		});

		await expect(
			hcp.dispatch({ target: "memory://session-grounding", op: "recall", input: { query: "typescript" } }),
		).resolves.toMatchObject({
			matches: [{ text: "Use TypeScript-first migration", tags: ["migration"] }],
		});
		await expect(readFile(storePath, "utf-8")).resolves.toContain("TypeScript-first migration");
	});

	it("serializes concurrent retains without losing either entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-session-grounding-concurrent-"));
		const storePath = join(dir, ".magenta", "memory", "session-grounding.jsonl");
		const first = new SessionGroundingMemoryProvider({ workspaceRoot: dir, storePath, now: () => 42 });
		const second = new SessionGroundingMemoryProvider({ workspaceRoot: dir, storePath, now: () => 42 });

		await Promise.all([first.retain({ text: "first fact" }), second.retain({ text: "second fact" })]);

		const entries = (await first.read()).entries;
		expect(entries.map((entry) => entry.text).sort()).toEqual(["first fact", "second fact"]);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
	});

	it("refuses symbolic-link stores without changing the linked target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-session-grounding-link-"));
		const memoryDir = join(dir, ".magenta", "memory");
		const target = join(dir, "outside.jsonl");
		const storePath = join(memoryDir, "session-grounding.jsonl");
		await writeFile(
			target,
			`${JSON.stringify({ id: "outside", text: "keep", scope: "project", tags: [], createdAt: 1 })}\n`,
		);
		await mkdir(memoryDir, { recursive: true });
		await symlink(target, storePath);
		const provider = new SessionGroundingMemoryProvider({ workspaceRoot: dir, storePath });

		await expect(provider.retain({ text: "must not write" })).rejects.toThrow(/plain file/u);
		await expect(readFile(target, "utf8")).resolves.toContain('"text":"keep"');
	});

	it("refuses an oversized memory store before parsing it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-session-grounding-large-"));
		const storePath = join(dir, ".magenta", "memory", "session-grounding.jsonl");
		await mkdir(join(dir, ".magenta", "memory"), { recursive: true });
		await writeFile(storePath, Buffer.alloc(SESSION_GROUNDING_STORE_MAX_BYTES + 1, 0x78));
		const provider = new SessionGroundingMemoryProvider({ workspaceRoot: dir, storePath });

		await expect(provider.read()).rejects.toThrow(/secure read limit/u);
	});
});
