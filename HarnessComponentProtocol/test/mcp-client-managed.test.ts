import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpStdioClient } from "../.HCP/transport/mcp-client.ts";
import type { ProcessRuntimeManagedHandle } from "../runtime/HcpServer.ts";
import { ProcessRuntimeProvider } from "../runtime/magenta/process-runtime.ts";
import { createManagedMcpSpawner } from "./mcp-test-utils.ts";

const MOCK_SERVER = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "greet", inputSchema: { type: "object" } }] });
  } else if (message.method === "tools/call" && message.params.name !== "hang") {
    send(message.id, { content: [{ type: "text", text: "hello " + message.params.arguments.name }] });
  }
});
`;

async function writeMockServer(): Promise<{ cwd: string; path: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "magenta-managed-mcp-"));
	const path = join(cwd, "server.cjs");
	await writeFile(path, MOCK_SERVER, { mode: 0o755 });
	return { cwd, path };
}

describe("managed MCP stdio client", () => {
	it("uses an injected runtime process for handshake, calls, and close", async () => {
		const server = await writeMockServer();
		const provider = new ProcessRuntimeProvider();
		let handle: ProcessRuntimeManagedHandle | undefined;
		const client = new McpStdioClient({
			command: process.execPath,
			args: [server.path],
			cwd: server.cwd,
			spawnManaged: createManagedMcpSpawner({
				provider,
				workspaceRoot: server.cwd,
				onSpawn: (spawned) => {
					handle = spawned;
				},
			}),
		});

		await client.connect();
		await expect(client.listTools()).resolves.toEqual([expect.objectContaining({ name: "greet" })]);
		await expect(client.callTool("greet", { name: "runtime" })).resolves.toMatchObject({
			content: [{ type: "text", text: "hello runtime" }],
		});

		await client.close();
		expect(client.isConnected).toBe(false);
		expect(handle).toBeDefined();
		await expect(handle!.exit).resolves.toMatchObject({ reason: "close" });
	});

	it("propagates AbortSignal termination to an in-flight request", async () => {
		const server = await writeMockServer();
		const provider = new ProcessRuntimeProvider();
		const controller = new AbortController();
		const client = new McpStdioClient({
			command: process.execPath,
			args: [server.path],
			cwd: server.cwd,
			requestTimeoutMs: 5_000,
			signal: controller.signal,
			spawnManaged: createManagedMcpSpawner({ provider, workspaceRoot: server.cwd }),
		});

		await client.connect();
		const pending = client.callTool("hang", {});
		controller.abort();
		await expect(pending).rejects.toThrow(/Operation aborted/);
		await client.close();
	});
});
