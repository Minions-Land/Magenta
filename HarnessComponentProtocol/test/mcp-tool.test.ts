import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpStdioClient } from "../_magenta/mcp/client.ts";
import { createMcpTools, discoverMcpTools, McpConnection, McpTool } from "../_magenta/mcp/tool.ts";
import { HcpClientloadpackageoverlay } from "../_magenta/packages/package-overlay-v2.ts";
import { createManagedMcpSpawner } from "./mcp-test-utils.ts";
import { HcpClientbuildpackagesessionfortest } from "./package-test-utils.ts";

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
	vi.restoreAllMocks();
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeMockServer(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-mock-"));
	temporaryRoots.push(dir);
	const path = join(dir, "mock-server.cjs");
	await writeFile(path, MOCK_MCP_SERVER, { mode: 0o755 });
	return path;
}

async function writeFanoutServer(toolNames: string[], closeMarker?: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-fanout-"));
	temporaryRoots.push(dir);
	const path = join(dir, "fanout-server.cjs");
	await writeFile(
		path,
		`const fs = require("node:fs");
const readline = require("node:readline");
const tools = ${JSON.stringify(toolNames)}.map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
const rl = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
${closeMarker ? `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(closeMarker)}, "closed"); process.exit(0); });` : ""}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") send(message.id, { tools });
  if (message.method === "tools/call") send(message.id, { content: [{ type: "text", text: "called " + message.params.name }] });
});
`,
		{ mode: 0o755 },
	);
	return path;
}

async function writeMalformedToolsServer(closeMarker: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "magenta-mcp-malformed-"));
	temporaryRoots.push(dir);
	const path = join(dir, "malformed-server.cjs");
	await writeFile(
		path,
		`const fs = require("node:fs");
	const readline = require("node:readline");
	const rl = readline.createInterface({ input: process.stdin });
	const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
	process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(closeMarker)}, "closed"); process.exit(0); });
	rl.on("line", (line) => {
	  const message = JSON.parse(line);
	  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
	  if (message.method === "tools/list") send(message.id, { tools: [{}] });
	});
	`,
		{ mode: 0o755 },
	);
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

	it("reconnects after the MCP server exits unexpectedly", async () => {
		const server = await writeMockServer();
		let spawnCount = 0;
		const connection = new McpConnection("mock", {
			command: process.execPath,
			args: [server],
			spawnManaged: (input, signal) => {
				spawnCount += 1;
				return spawnManagedMcp(input, signal);
			},
		});
		const schema = (await connection.listTools()).find((tool) => tool.name === "greet")!;
		const product = new McpTool({ connection, tool: schema });
		await product.toTool().execute("first", { name: "__close_after__" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		await expect(product.toTool().execute("second", { name: "again" })).resolves.toMatchObject({
			content: [{ type: "text", text: "hello again" }],
		});
		expect(spawnCount).toBe(2);
		await product.close();
		await connection.close();
	});

	it("allows a new tool lease after the previous lease released the idle client", async () => {
		const server = await writeMockServer();
		let spawnCount = 0;
		const connection = new McpConnection("mock", {
			command: process.execPath,
			args: [server],
			spawnManaged: (input, signal) => {
				spawnCount += 1;
				return spawnManagedMcp(input, signal);
			},
		});
		const schema = (await connection.listTools()).find((tool) => tool.name === "greet")!;
		const first = new McpTool({ connection, tool: schema });
		await first.close();

		const second = new McpTool({ connection, tool: schema });
		await expect(second.toTool().execute("second-lease", { name: "lease" })).resolves.toMatchObject({
			content: [{ type: "text", text: "hello lease" }],
		});
		expect(spawnCount).toBe(2);
		await second.close();
		await connection.close();
	});

	it("closes the public createMcpTools connection when discovery returns no tools", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "magenta-mcp-helper-zero-"));
		temporaryRoots.push(markerRoot);
		const marker = join(markerRoot, "closed.txt");
		const server = await writeFanoutServer([], marker);

		await expect(
			createMcpTools({
				serverName: "empty",
				client: { command: process.execPath, args: [server], spawnManaged: spawnManagedMcp },
			}),
		).resolves.toEqual([]);
		expect(await readFile(marker, "utf-8")).toBe("closed");
	});

	it("rejects malformed tools/list schemas and closes the connection", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "magenta-mcp-malformed-marker-"));
		temporaryRoots.push(markerRoot);
		const marker = join(markerRoot, "closed.txt");
		const server = await writeMalformedToolsServer(marker);

		await expect(
			discoverMcpTools({
				serverName: "malformed",
				client: { command: process.execPath, args: [server], spawnManaged: spawnManagedMcp },
			}),
		).rejects.toThrow(/tool\[0\].*name/);
		expect(await readFile(marker, "utf-8")).toBe("closed");
	});

	it("preserves a discovery failure when closing the connection also fails", async () => {
		const discoveryFailure = new Error("discovery failed");
		vi.spyOn(McpConnection.prototype, "listTools").mockRejectedValue(discoveryFailure);
		const close = vi.spyOn(McpConnection.prototype, "close").mockRejectedValue(new Error("close failed"));

		await expect(
			discoverMcpTools({
				serverName: "broken-discovery",
				client: { command: process.execPath, spawnManaged: spawnManagedMcp },
			}),
		).rejects.toBe(discoveryFailure);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("preserves a tool construction failure when closing the connection also fails", async () => {
		const constructionFailure = new Error("construction failed");
		vi.spyOn(McpConnection.prototype, "listTools").mockResolvedValue([
			{ name: "remote", inputSchema: { type: "object" } },
		]);
		vi.spyOn(McpConnection.prototype, "retainTool").mockImplementation(() => {
			throw constructionFailure;
		});
		const close = vi.spyOn(McpConnection.prototype, "close").mockRejectedValue(new Error("close failed"));

		await expect(
			createMcpTools({
				serverName: "broken-construction",
				client: { command: process.execPath, spawnManaged: spawnManagedMcp },
			}),
		).rejects.toBe(constructionFailure);
		expect(close).toHaveBeenCalledTimes(1);
	});
});

async function writeMcpPackage(descriptorToml: string): Promise<string> {
	const packagesRoot = await mkdtemp(join(tmpdir(), "magenta-mcp-package-"));
	temporaryRoots.push(packagesRoot);
	const { writeFixturePackage } = await import("./package-v2-fixtures.ts");
	await writeFixturePackage(packagesRoot, {
		id: "MockPkg",
		source: "MockPkg",
		components: [{ kind: "tool", item: "bio-api", name: "bio_api", source: "MockPkg", descriptorToml }],
	});
	// Return the packages root; callers use it as both the overlay packagesRoot
	// and the session repoRoot (the package is self-contained under it).
	return packagesRoot;
}

describe("MCP package tool assembly", () => {
	it("lets an explicit Package override a repository tool without dropping later fan-out tools", async () => {
		const server = await writeFanoutServer(["web-search", "unique"]);
		const repoRoot = await writeMcpPackage(
			[
				'kind = "tool"',
				'name = "fanout"',
				'runtime = "mcp"',
				`command = ${JSON.stringify(process.execPath)}`,
				`args = [${JSON.stringify(server)}]`,
			].join("\n"),
		);
		const overlay = await HcpClientloadpackageoverlay({ packagesRoot: repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildpackagesessionfortest({ repoRoot, overlay });

		expect(assembled.diagnostics).toEqual([]);
		expect(assembled.packageToolAddresses).toEqual(["tool:web-search", "tool:unique"]);
		const overridden = assembled.hcp.resolveInstance<AgentTool>("tool:web-search")!;
		await expect(overridden.execute("web-search-1", {})).resolves.toMatchObject({
			content: [{ type: "text", text: "called web-search" }],
		});
		const unique = assembled.hcp.resolveInstance<AgentTool>("tool:unique")!;
		await expect(unique.execute("unique-1", {})).resolves.toMatchObject({
			content: [{ type: "text", text: "called unique" }],
		});
		await assembled.hcp.dispose();
	});

	it("closes an MCP connection when discovery returns no tools", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "magenta-mcp-zero-marker-"));
		temporaryRoots.push(markerRoot);
		const marker = join(markerRoot, "closed.txt");
		const server = await writeFanoutServer([], marker);
		const repoRoot = await writeMcpPackage(
			[
				'kind = "tool"',
				'name = "empty"',
				'runtime = "mcp"',
				`command = ${JSON.stringify(process.execPath)}`,
				`args = [${JSON.stringify(server)}]`,
			].join("\n"),
		);
		const overlay = await HcpClientloadpackageoverlay({ packagesRoot: repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildpackagesessionfortest({ repoRoot, overlay });

		expect(assembled.packageToolAddresses).toEqual([]);
		expect(await readFile(marker, "utf-8")).toBe("closed");
		await assembled.hcp.dispose();
	});

	it("does not start MCP products owned by a disabled Module", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "magenta-mcp-disabled-marker-"));
		temporaryRoots.push(markerRoot);
		const marker = join(markerRoot, "closed.txt");
		const server = await writeFanoutServer(["unique"], marker);
		const repoRoot = await writeMcpPackage(
			[
				'kind = "tool"',
				'name = "disabled"',
				'runtime = "mcp"',
				`command = ${JSON.stringify(process.execPath)}`,
				`args = [${JSON.stringify(server)}]`,
			].join("\n"),
		);
		const overlay = await HcpClientloadpackageoverlay({ packagesRoot: repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildpackagesessionfortest({ repoRoot, overlay, disabledModules: ["tools"] });

		expect(assembled.packageToolAddresses).toEqual([]);
		await expect(readFile(marker, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		await assembled.hcp.dispose();
	});

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
		const overlay = await HcpClientloadpackageoverlay({ packagesRoot: repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildpackagesessionfortest({ repoRoot, overlay });

		expect(assembled.diagnostics).toEqual([]);
		expect(assembled.packageToolAddresses.sort()).toEqual(["tool:bio_boom", "tool:bio_greet"]);
		await expect(assembled.hcp.dispatch({ target: "tool:bio_greet", op: "describe" })).resolves.toMatchObject({
			target: "tool:bio_greet",
			kind: "tool",
			metadata: {
				implementation: "mcp",
				source: "MockPkg",
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
		const overlay = await HcpClientloadpackageoverlay({ packagesRoot: repoRoot, selections: ["MockPkg"] });
		const assembled = await HcpClientbuildpackagesessionfortest({ repoRoot, overlay });

		expect(assembled.packageToolAddresses).toEqual([]);
		expect(assembled.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "error",
				code: "package_tool_descriptor_invalid",
			}),
		);
	});
});
