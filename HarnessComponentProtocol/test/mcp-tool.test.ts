import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import { loadPackageOverlay } from "../.HCP/overlay/package-overlay.ts";
import { discoverMcpTools, McpConnection, McpTool } from "../.HCP/transport/mcp.ts";
import { McpStdioClient } from "../.HCP/transport/mcp-client.ts";
import { createManagedMcpSpawner } from "./mcp-test-utils.ts";

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
      if (args.name === "__close_after__") setImmediate(() => process.exit(0));
    } else if (name === "boom") {
      send(msg.id, { content: [{ type: "text", text: "kaboom" }], isError: true });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } }) + "\\n");
    }
  }
});
`;

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeMockServer(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-mock-"));
	temporaryRoots.push(dir);
	const path = join(dir, "mock-server.cjs");
	await writeFile(path, MOCK_MCP_SERVER, { mode: 0o755 });
	return path;
}
const spawnManagedMcp = createManagedMcpSpawner();

describe("MCP stdio client", () => {
	it("initializes, lists tools, and calls a tool", async () => {
		const server = await writeMockServer();
		const client = new McpStdioClient({
			command: process.execPath,
			args: [server],
			spawnManaged: spawnManagedMcp,
		});
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
		const client = new McpStdioClient({
			command: process.execPath,
			args: [server],
			spawnManaged: spawnManagedMcp,
		});
		try {
			await client.connect();
			await expect(client.callTool("does-not-exist", {})).rejects.toThrow(/unknown tool/);
		} finally {
			await client.close();
		}
	});
});

describe("MCP tools", () => {
	it("fans out one tool product per remote tool over a shared managed connection", async () => {
		const server = await writeMockServer();
		const discovered = await discoverMcpTools({
			serverName: "mock",
			namePrefix: "bio",
			client: { command: process.execPath, args: [server], spawnManaged: spawnManagedMcp },
		});
		try {
			const mcpTools = discovered.tools.map(
				(tool) => new McpTool({ connection: discovered.connection, tool, namePrefix: "bio" }),
			);
			expect(mcpTools).toHaveLength(2);

			const greet = mcpTools.find((source) => source.toTool().name === "bio_greet");
			expect(greet).toBeDefined();
			const tool = greet!.toTool();
			expect(tool.label).toBe("greet");
			expect(tool.description).toBe("Greets by name");
			expect(tool.provenance).toEqual({ kind: "mcp", server: "mock", remoteTool: "greet" });

			const result = await tool.execute("call-1", { name: "kiro" });
			expect(result.content[0]).toMatchObject({ type: "text", text: "hello kiro" });
			expect(result.details).toMatchObject({ server: "mock", remoteTool: "greet", isError: false });
			expect((greet as { toHcpServer?: unknown }).toHcpServer).toBeUndefined();
		} finally {
			await discovered.connection.close();
		}
	});

	it("marks isError results from the remote tool", async () => {
		const server = await writeMockServer();
		const discovered = await discoverMcpTools({
			serverName: "mock",
			client: { command: process.execPath, args: [server], spawnManaged: spawnManagedMcp },
		});
		try {
			const boomSchema = discovered.tools.find((tool) => tool.name === "boom");
			expect(boomSchema).toBeDefined();
			const boom = new McpTool({ connection: discovered.connection, tool: boomSchema! });
			const result = await boom.toTool().execute("call-2", {});
			expect(result.details.isError).toBe(true);
			expect(result.content[0]).toMatchObject({ type: "text", text: "kaboom" });
		} finally {
			await discovered.connection.close();
		}
	});

	it("shares a single connection across sequential calls", async () => {
		const server = await writeMockServer();
		const connection = new McpConnection("mock", {
			command: process.execPath,
			args: [server],
			spawnManaged: spawnManagedMcp,
		});
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

async function writeMcpPackage(descriptor: string): Promise<string> {
	const repoRoot = await mkdtemp(join(tmpdir(), "magenta-mcp-package-"));
	temporaryRoots.push(repoRoot);
	const packageRoot = join(repoRoot, "packages", "MockPkg");
	const harnessRoot = join(packageRoot, "harness");
	const toolsRoot = join(harnessRoot, "tools");
	await mkdir(toolsRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "package.toml"),
		`schema_version = "magenta.package.v1"
id = "MockPkg"
name = "Mock MCP Package"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "harness/harness.toml"
`,
	);
	await writeFile(
		join(harnessRoot, "harness.toml"),
		`[[components]]
kind = "tool"
name = "bio_api"
path = "tools/bio-api.toml"
`,
	);
	await writeFile(join(toolsRoot, "bio-api.toml"), descriptor);
	return repoRoot;
}

describe("MCP package tool assembly", () => {
	it("expands one descriptor into N tools through the session HcpClient", async () => {
		const server = await writeMockServer();
		const repoRoot = await writeMcpPackage(
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
		const overlay = await loadPackageOverlay({ repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildsession({ repoRoot, overlay });

		expect(assembled.diagnostics).toEqual([]);
		expect(assembled.packageToolAddresses.sort()).toEqual(["tool:bio_boom", "tool:bio_greet"]);
		await expect(assembled.hcp.dispatch({ target: "tool:bio_greet", op: "describe" })).resolves.toMatchObject({
			target: "tool:bio_greet",
			kind: "tool",
			metadata: {
				implementation: "mcp",
				source: "descriptor",
				provenance: { kind: "mcp", server: "bio_api", remoteTool: "greet" },
			},
		});
		const greet = assembled.hcp.resolveInstance<AgentTool>("tool:bio_greet");
		expect(greet?.name).toBe("bio_greet");
		await expect(greet!.execute("c1", { name: "__close_after__" })).resolves.toMatchObject({
			content: [{ type: "text", text: "hello __close_after__" }],
		});
	});

	it("reports a descriptor error when an MCP command is missing", async () => {
		const repoRoot = await writeMcpPackage(['kind = "tool"', 'name = "bio_api"', 'runtime = "mcp"'].join("\n"));
		const overlay = await loadPackageOverlay({ repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildsession({ repoRoot, overlay });

		expect(assembled.packageToolAddresses).toEqual([]);
		expect(assembled.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "error",
				code: "package_tool_descriptor_invalid",
			}),
		);
	});
});
