import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpToolMagnets } from "../hcp-magnet/mcp.ts";
import { readMcpToolsCache, writeMcpToolsCache } from "../hcp-magnet/mcp-cache.ts";

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

interface Fixture {
	serverPath: string;
	markerPath: string;
	cacheDir: string;
}

async function makeFixture(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-cache-"));
	const serverPath = join(dir, "spawn-server.cjs");
	await writeFile(serverPath, SPAWN_COUNTING_SERVER, { mode: 0o755 });
	return { serverPath, markerPath: join(dir, "spawns.log"), cacheDir: join(dir, "cache") };
}

async function spawnCount(markerPath: string): Promise<number> {
	if (!existsSync(markerPath)) return 0;
	const text = await readFile(markerPath, "utf-8");
	return text.split("\n").filter((l) => l === "spawn").length;
}

describe("MCP tools/list disk cache", () => {
	it("spawns on cold assembly, then serves warm assembly from cache without spawning", async () => {
		const fx = await makeFixture();
		const client = { command: process.execPath, args: [fx.serverPath, fx.markerPath] };

		// Cold: cache miss → spawns and enumerates.
		const cold = await createMcpToolMagnets({
			serverName: "mock",
			client,
			cache: { dir: fx.cacheDir },
		});
		expect(cold.map((m) => m.toTool?.()?.name)).toEqual(["greet"]);
		expect(await spawnCount(fx.markerPath)).toBe(1);

		// Warm: cache hit → no additional spawn, same tools.
		const warm = await createMcpToolMagnets({
			serverName: "mock",
			client,
			cache: { dir: fx.cacheDir },
		});
		expect(warm.map((m) => m.toTool?.()?.name)).toEqual(["greet"]);
		expect(await spawnCount(fx.markerPath)).toBe(1); // unchanged: no re-spawn
	});

	it("invalidates the cache when the binary mtime changes (rebuild)", async () => {
		const fx = await makeFixture();
		const client = { command: process.execPath, args: [fx.serverPath, fx.markerPath] };

		await createMcpToolMagnets({ serverName: "mock", client, cache: { dir: fx.cacheDir } });
		expect(await spawnCount(fx.markerPath)).toBe(1);

		// Warm read serves from cache.
		await createMcpToolMagnets({ serverName: "mock", client, cache: { dir: fx.cacheDir } });
		expect(await spawnCount(fx.markerPath)).toBe(1);

		// Simulate a rebuild: bump the binary mtime and change its content.
		await appendFile(fx.serverPath, "\n// rebuilt\n");
		const future = new Date(Date.now() + 10_000);
		await utimes(fx.serverPath, future, future);

		// Next assembly must re-spawn because the binary identity changed.
		await createMcpToolMagnets({ serverName: "mock", client, cache: { dir: fx.cacheDir } });
		expect(await spawnCount(fx.markerPath)).toBe(2);
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
});
