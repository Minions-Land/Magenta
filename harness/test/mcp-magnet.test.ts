import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpToolMagnets, McpConnection } from "../harness-component-protocol/magnet/mcp.ts";
import { McpStdioClient } from "../harness-component-protocol/magnet/mcp-client.ts";
import { createPackageToolMagnet } from "../harness-component-protocol/magnet/package-tool.ts";

/**
 * A minimal MCP stdio server implemented in Node for tests. It speaks the same
 * newline-delimited JSON-RPC 2.0 subset the harness client uses: `initialize`,
 * `tools/list`, and `tools/call`, plus it ignores the `notifications/initialized`
 * notification.
 */
const MOCK_MCP_SERVER = `#!/usr/bin/env node
const readline = require("node:readline");
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
  } else if (msg.method === "notifications/initialized") {
    // notification: no response
  } else if (msg.method === "tools/list") {
    send(msg.id, {
      tools: [
        {
          name: "greet",
          description: "Greets by name",
          inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        },
        {
          name: "boom",
          description: "Always errors",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "greet") {
      send(msg.id, { content: [{ type: "text", text: "hello " + args.name }] });
    } else if (name === "boom") {
      send(msg.id, { content: [{ type: "text", text: "kaboom" }], isError: true });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } }) + "\\n");
    }
  }
});
`;

async function writeMockServer(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-mock-"));
	const path = join(dir, "mock-server.cjs");
	await writeFile(path, MOCK_MCP_SERVER, { mode: 0o755 });
	return path;
}

describe("MCP stdio client", () => {
	it("initializes, lists tools, and calls a tool", async () => {
		const server = await writeMockServer();
		const client = new McpStdioClient({ command: process.execPath, args: [server] });
		try {
			await client.connect();
			expect(client.isConnected).toBe(true);

			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["greet", "boom"]);

			const result = await client.callTool("greet", { name: "world" });
			expect(result.content[0]).toMatchObject({ type: "text", text: "hello world" });
			expect(result.isError).toBeFalsy();
		} finally {
			await client.close();
		}
		expect(client.isConnected).toBe(false);
	});

	it("surfaces JSON-RPC errors as rejections", async () => {
		const server = await writeMockServer();
		const client = new McpStdioClient({ command: process.execPath, args: [server] });
		try {
			await client.connect();
			await expect(client.callTool("does-not-exist", {})).rejects.toThrow(/unknown tool/);
		} finally {
			await client.close();
		}
	});
});

describe("MCP magnets", () => {
	it("fans out one magnet per remote tool over a shared connection", async () => {
		const server = await writeMockServer();
		const magnets = await createMcpToolMagnets({
			serverName: "mock",
			namePrefix: "bio",
			client: { command: process.execPath, args: [server] },
		});
		expect(magnets).toHaveLength(2);

		const greet = magnets.find((m) => m.toTool().name === "bio_greet");
		expect(greet).toBeDefined();
		const tool = greet!.toTool();
		expect(tool.label).toBe("greet");
		expect(tool.description).toBe("Greets by name");
		expect(tool.provenance).toEqual({ kind: "mcp", server: "mock", remoteTool: "greet" });

		const result = await tool.execute("call-1", { name: "kiro" });
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello kiro" });
		expect(result.details).toMatchObject({ server: "mock", remoteTool: "greet", isError: false });

		// Close the shared connection via any magnet's underlying client.
		for (const magnet of magnets) {
			const target = magnet.toHcpServer();
			expect(target.describe().kind).toBe("tool");
		}
	});

	it("marks isError results from the remote tool", async () => {
		const server = await writeMockServer();
		const magnets = await createMcpToolMagnets({
			serverName: "mock",
			client: { command: process.execPath, args: [server] },
		});
		const boom = magnets.find((m) => m.toTool().name === "boom");
		expect(boom).toBeDefined();
		const result = await boom!.toTool().execute("call-2", {});
		expect(result.details.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: "kaboom" });
	});

	it("shares a single connection across sequential calls", async () => {
		const server = await writeMockServer();
		const connection = new McpConnection("mock", { command: process.execPath, args: [server] });
		const tools = await connection.listTools();
		expect(tools).toHaveLength(2);
		// Reuse the already-connected connection.
		const first = await connection.callTool("greet", { name: "a" });
		const second = await connection.callTool("greet", { name: "b" });
		expect(first.content[0]).toMatchObject({ text: "hello a" });
		expect(second.content[0]).toMatchObject({ text: "hello b" });
		await connection.close();
	});
});

describe("MCP package-tool cable (runtime = mcp)", () => {
	it("assembles fan-out magnets from an mcp descriptor", async () => {
		const server = await writeMockServer();
		const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-descriptor-"));
		const descriptorPath = join(dir, "bio-api.toml");
		await writeFile(
			descriptorPath,
			[
				'kind = "tool"',
				'name = "bio_api"',
				'description = "Mock MCP server"',
				'runtime = "mcp"',
				`command = ${JSON.stringify(process.execPath)}`,
				`args = [${JSON.stringify(server)}]`,
				'name_prefix = "bio"',
				"timeout_ms = 15000",
			].join("\n"),
		);

		const result = await createPackageToolMagnet({
			component: {
				packageId: "MockPkg",
				kind: "tool",
				name: "bio_api",
				path: descriptorPath,
				sourcePath: descriptorPath,
			},
			context: {
				repoRoot: dir,
				packagesRoot: dir,
				components: [],
				componentMap: new Map(),
			},
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.magnet).toBeUndefined();
		expect(result.magnets).toBeDefined();
		const magnets = result.magnets ?? [];
		expect(magnets).toHaveLength(2);

		const toolNames = magnets.map((m) => m.toTool?.()?.name).sort();
		expect(toolNames).toEqual(["bio_boom", "bio_greet"]);

		const greet = magnets.find((m) => m.toTool?.()?.name === "bio_greet");
		const greetResult = await greet!.toTool!().execute("c1", { name: "cable" });
		expect(greetResult.content[0]).toMatchObject({ type: "text", text: "hello cable" });
	});

	it("emits a diagnostic when an mcp descriptor omits command", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-baddesc-"));
		const descriptorPath = join(dir, "bad.toml");
		await writeFile(descriptorPath, ['kind = "tool"', 'name = "bad"', 'runtime = "mcp"'].join("\n"));

		const result = await createPackageToolMagnet({
			component: {
				packageId: "MockPkg",
				kind: "tool",
				name: "bad",
				path: descriptorPath,
				sourcePath: descriptorPath,
			},
			context: { repoRoot: dir, packagesRoot: dir, components: [], componentMap: new Map() },
		});

		expect(result.magnet).toBeUndefined();
		expect(result.magnets).toBeUndefined();
		expect(result.diagnostics.some((d) => d.type === "error")).toBe(true);
	});
});
