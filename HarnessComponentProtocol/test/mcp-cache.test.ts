import { existsSync } from "node:fs";
import {
	appendFile,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupMcpToolsCache, readMcpToolsCache, writeMcpToolsCache } from "../_magenta/mcp/cache.ts";
import { type CreateMcpToolsOptions, discoverMcpTools } from "../_magenta/mcp/tool.ts";
import { createManagedMcpSpawner } from "./mcp-test-utils.ts";

/**
 * A mock MCP server that records every spawn by appending to a marker file
 * whose path is passed as argv[2]. This lets a test assert whether assembly
 * spawned the binary (cache miss) or skipped it (cache hit).
 */
const SPAWN_COUNTING_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const markerPath = process.argv[2];
fs.appendFileSync(markerPath, "spawn\\n");
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === "initialize") {
    send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0.0.1" } });
  } else if (msg.method === "tools/list") {
    send(msg.id, { tools: [{ name: "greet", description: "Greets", inputSchema: { type: "object", properties: {} } }] });
  } else if (msg.method === "tools/call") {
    send(msg.id, { content: [{ type: "text", text: "ok" }] });
  }
});
`;

type Fixture = {
	root: string;
	serverPath: string;
	markerPath: string;
	cacheDir: string;
};

async function makeFixture(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-cache-"));
	const serverPath = join(dir, "spawn-server.cjs");
	await writeFile(serverPath, SPAWN_COUNTING_SERVER, { mode: 0o755 });
	return { root: dir, serverPath, markerPath: join(dir, "spawns.log"), cacheDir: join(dir, "cache") };
}

async function spawnCount(markerPath: string): Promise<number> {
	if (!existsSync(markerPath)) return 0;
	const text = await readFile(markerPath, "utf-8");
	return text.split("\n").filter((l) => l === "spawn").length;
}

async function discoverToolNames(options: CreateMcpToolsOptions): Promise<string[]> {
	const discovered = await discoverMcpTools(options);
	try {
		return discovered.tools.map((tool) => tool.name);
	} finally {
		await discovered.connection.close();
	}
}

const spawnManagedMcp = createManagedMcpSpawner();

describe("MCP tools/list disk cache", () => {
	it("does not share schemas across different client working directories", async () => {
		const fx = await makeFixture();
		const left = await mkdtemp(join(tmpdir(), "magenta-mcp-left-"));
		const right = await mkdtemp(join(tmpdir(), "magenta-mcp-right-"));
		const base = {
			cacheDir: fx.cacheDir,
			serverName: "mock",
			client: { command: process.execPath, args: [fx.serverPath, fx.markerPath], cwd: left },
		};
		await writeMcpToolsCache(base, [{ name: "left" }]);

		expect(await readMcpToolsCache(base)).toEqual([{ name: "left" }]);
		expect(await readMcpToolsCache({ ...base, client: { ...base.client, cwd: right } })).toBeUndefined();
	});

	it("spawns on cold assembly, then serves warm assembly from cache without spawning", async () => {
		const fx = await makeFixture();
		const client = {
			command: process.execPath,
			args: [fx.serverPath, fx.markerPath],
			spawnManaged: spawnManagedMcp,
		};

		// Cold: cache miss → spawns and enumerates.
		const coldTools = await discoverToolNames({
			serverName: "mock",
			client,
			cache: { dir: fx.cacheDir },
		});
		expect(coldTools).toEqual(["greet"]);
		expect(await spawnCount(fx.markerPath)).toBe(1);

		// Warm: cache hit → no additional spawn, same tools.
		const warmTools = await discoverToolNames({
			serverName: "mock",
			client,
			cache: { dir: fx.cacheDir },
		});
		expect(warmTools).toEqual(["greet"]);
		expect(await spawnCount(fx.markerPath)).toBe(1); // unchanged: no re-spawn
	});

	it("invalidates the cache when the binary mtime changes (rebuild)", async () => {
		const fx = await makeFixture();
		const client = {
			command: process.execPath,
			args: [fx.serverPath, fx.markerPath],
			spawnManaged: spawnManagedMcp,
		};

		await discoverToolNames({ serverName: "mock", client, cache: { dir: fx.cacheDir } });
		expect(await spawnCount(fx.markerPath)).toBe(1);

		// Warm read serves from cache.
		await discoverToolNames({ serverName: "mock", client, cache: { dir: fx.cacheDir } });
		expect(await spawnCount(fx.markerPath)).toBe(1);

		// Simulate a rebuild: bump the binary mtime and change its content.
		await appendFile(fx.serverPath, "\n// rebuilt\n");
		const future = new Date(Date.now() + 10_000);
		await utimes(fx.serverPath, future, future);

		// Next assembly must re-spawn because the binary identity changed.
		await discoverToolNames({ serverName: "mock", client, cache: { dir: fx.cacheDir } });
		expect(await spawnCount(fx.markerPath)).toBe(2);
	});

	it("invalidates a same-size binary replacement even when mtime is preserved", async () => {
		const fx = await makeFixture();
		const options = {
			cacheDir: fx.cacheDir,
			serverName: "mock",
			client: { command: process.execPath, args: [fx.serverPath] },
		};
		await writeMcpToolsCache(options, [{ name: "greet" }]);
		expect(await readMcpToolsCache(options)).toEqual([{ name: "greet" }]);

		const original = await stat(fx.serverPath);
		const replacement = `${fx.serverPath}.replacement`;
		await writeFile(replacement, SPAWN_COUNTING_SERVER, { mode: 0o755 });
		await utimes(replacement, original.atime, original.mtime);
		await rename(replacement, fx.serverPath);

		await expect(readMcpToolsCache(options)).resolves.toBeUndefined();
	});

	it("resolves bare commands through PATH and invalidates replacements", async () => {
		const fx = await makeFixture();
		const binDir = join(fx.root, "bin");
		await mkdir(binDir);
		const commandName = process.platform === "win32" ? "mock-mcp.cmd" : "mock-mcp";
		const commandPath = join(binDir, commandName);
		await writeFile(commandPath, "first");
		const options = {
			cacheDir: fx.cacheDir,
			serverName: "path-command",
			client: { command: commandName, env: { PATH: binDir } },
		};

		await writeMcpToolsCache(options, [{ name: "cached" }]);
		await expect(readMcpToolsCache(options)).resolves.toEqual([{ name: "cached" }]);

		await writeFile(commandPath, "second");
		await expect(readMcpToolsCache(options)).resolves.toBeUndefined();
	});

	it("does not cache a command whose executable identity cannot be resolved", async () => {
		const fx = await makeFixture();
		const options = {
			cacheDir: fx.cacheDir,
			serverName: "missing-command",
			client: { command: "definitely-not-a-real-magenta-command", env: { PATH: fx.root } },
		};

		await writeMcpToolsCache(options, [{ name: "cached" }]);
		await expect(readMcpToolsCache(options)).resolves.toBeUndefined();
	});

	it("keeps enforcing the file ceiling as new entries are written", async () => {
		const fx = await makeFixture();
		for (let index = 0; index < 132; index++) {
			await writeMcpToolsCache(
				{
					cacheDir: fx.cacheDir,
					serverName: `server-${index}`,
					client: { command: process.execPath, args: [fx.serverPath, String(index)] },
				},
				[{ name: `tool-${index}` }],
			);
		}

		const files = (await readdir(fx.cacheDir)).filter((name) => name.endsWith(".json"));
		expect(files.length).toBeLessThanOrEqual(128);
	});

	it("counts protected managed entries toward an explicit file ceiling", async () => {
		const fx = await makeFixture();
		const baseClient = { command: process.execPath, args: [fx.serverPath] };
		for (const serverName of ["oldest", "middle", "protected"]) {
			await writeMcpToolsCache({ cacheDir: fx.cacheDir, serverName, client: baseClient }, [{ name: serverName }]);
		}
		const protectedName = (await readdir(fx.cacheDir)).find((name) => name.startsWith("protected-"));
		expect(protectedName).toBeDefined();
		const protectedPath = join(fx.cacheDir, protectedName!);

		const result = await cleanupMcpToolsCache({
			cacheDir: fx.cacheDir,
			protectedPaths: [protectedPath],
			maxAgeMs: -1,
			maxFiles: 2,
		});

		expect(result.deletedFiles).toBe(1);
		expect((await readdir(fx.cacheDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
		await expect(readFile(protectedPath, "utf8")).resolves.toContain('"cachedAt"');
	});

	it("read returns undefined when args differ from the cached entry", async () => {
		const fx = await makeFixture();
		const base = {
			cacheDir: fx.cacheDir,
			serverName: "mock",
			client: { command: process.execPath, args: [fx.serverPath, fx.markerPath] },
		};
		await writeMcpToolsCache(base, [{ name: "greet" }]);

		expect(await readMcpToolsCache(base)).toEqual([{ name: "greet" }]);
		// Different args → miss.
		const miss = await readMcpToolsCache({ ...base, client: { ...base.client, args: ["other"] } });
		expect(miss).toBeUndefined();
	});

	it("read returns undefined when descriptor env differs", async () => {
		const fx = await makeFixture();
		const base = {
			cacheDir: fx.cacheDir,
			serverName: "mock",
			client: { command: process.execPath, args: [fx.serverPath], env: { KEY: "a" } },
		};
		await writeMcpToolsCache(base, [{ name: "greet" }]);

		expect(await readMcpToolsCache(base)).toEqual([{ name: "greet" }]);
		const miss = await readMcpToolsCache({ ...base, client: { ...base.client, env: { KEY: "b" } } });
		expect(miss).toBeUndefined();
	});

	it("treats malformed cache entry fields as a miss instead of throwing", async () => {
		const fx = await makeFixture();
		const options = {
			cacheDir: fx.cacheDir,
			serverName: "mock",
			client: { command: process.execPath, args: [fx.serverPath] },
		};
		await writeMcpToolsCache(options, [{ name: "greet" }]);
		const [cacheName] = await readdir(fx.cacheDir);
		await writeFile(join(fx.cacheDir, cacheName!), JSON.stringify({ formatVersion: 1, args: "not-an-array" }));

		await expect(readMcpToolsCache(options)).resolves.toBeUndefined();
	});

	it("does not serve entries outside the freshness window", async () => {
		const fx = await makeFixture();
		const options = {
			cacheDir: fx.cacheDir,
			serverName: "mock",
			client: { command: process.execPath, args: [fx.serverPath] },
		};
		await writeMcpToolsCache(options, [{ name: "greet" }]);
		const [cacheName] = await readdir(fx.cacheDir);
		const cachePath = join(fx.cacheDir, cacheName!);
		const entry = JSON.parse(await readFile(cachePath, "utf8")) as { cachedAt: number };

		entry.cachedAt = 0;
		await writeFile(cachePath, `${JSON.stringify(entry)}\n`);
		await expect(readMcpToolsCache(options)).resolves.toBeUndefined();

		entry.cachedAt = Date.now() + 60_000;
		await writeFile(cachePath, `${JSON.stringify(entry)}\n`);
		await expect(readMcpToolsCache(options)).resolves.toBeUndefined();
	});

	it("deletes only old generated entries with proven ownership and no active writer", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = await makeFixture();
		const baseClient = { command: process.execPath, args: [fx.serverPath] };
		const old = { cacheDir: fx.cacheDir, serverName: "old", client: baseClient };
		const recent = { cacheDir: fx.cacheDir, serverName: "recent", client: baseClient };
		const locked = { cacheDir: fx.cacheDir, serverName: "locked", client: baseClient };
		const linked = { cacheDir: fx.cacheDir, serverName: "linked", client: baseClient };
		for (const options of [old, recent, locked, linked]) await writeMcpToolsCache(options, [{ name: "greet" }]);
		const names = (await readdir(fx.cacheDir)).sort();
		const byPrefix = (prefix: string) => names.find((name) => name.startsWith(`${prefix}-`))!;
		const oldPath = join(fx.cacheDir, byPrefix("old"));
		const recentPath = join(fx.cacheDir, byPrefix("recent"));
		const lockedPath = join(fx.cacheDir, byPrefix("locked"));
		const linkedPath = join(fx.cacheDir, byPrefix("linked"));
		const oldTime = new Date(1);
		await Promise.all([oldPath, lockedPath, linkedPath].map((path) => utimes(path, oldTime, oldTime)));
		for (const path of [oldPath, lockedPath, linkedPath]) {
			const parsed = JSON.parse(await readFile(path, "utf8")) as { cachedAt: number };
			parsed.cachedAt = 1;
			await writeFile(path, `${JSON.stringify(parsed)}\n`);
			await utimes(path, oldTime, oldTime);
		}
		await mkdir(`${lockedPath}.lock`);
		await link(linkedPath, `${linkedPath}.alias`);
		await writeFile(join(fx.cacheDir, "unknown.json"), "unknown");
		await symlink(oldPath, join(fx.cacheDir, "symlink-0000000000000000.json"));

		const result = await cleanupMcpToolsCache({ cacheDir: fx.cacheDir, maxAgeMs: 100, now: 20_000 });
		expect(result.deletedFiles).toBe(1);
		await expect(lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(recentPath, "utf8")).resolves.toContain('"cachedAt"');
		await expect(readFile(lockedPath, "utf8")).resolves.toContain('"cachedAt"');
		await expect(readFile(linkedPath, "utf8")).resolves.toContain('"cachedAt"');
		await expect(readFile(join(fx.cacheDir, "unknown.json"), "utf8")).resolves.toBe("unknown");
	});
});
