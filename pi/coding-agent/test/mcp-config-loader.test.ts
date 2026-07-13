import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HcpClient, HcpClientbuildsession, McpConnection } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { loadUserMcpTools } from "../src/core/mcp-config-loader.ts";

describe("loadUserMcpTools", () => {
	let dir: string;
	let prevAgentDir: string | undefined;
	let hcp: HcpClient;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "mcp-loader-"));
		prevAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = dir;
		hcp = (await HcpClientbuildsession({ repoRoot: dir })).hcp;
	});

	afterEach(async () => {
		await hcp.dispose();
		vi.restoreAllMocks();
		if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = prevAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (content: string) => writeFileSync(join(dir, "mcp-servers.json"), content, "utf-8");
	const load = () => loadUserMcpTools({ hcp, cwd: dir, agentDir: dir });
	const writeLifecycleServer = (filename: string, eventsPath: string, toolNames: string[]) => {
		const serverPath = join(dir, filename);
		writeFileSync(
			serverPath,
			`const fs = require("node:fs");
const readline = require("node:readline");
const eventsPath = ${JSON.stringify(eventsPath)};
const tools = ${JSON.stringify(toolNames)}.map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object" }
}));
fs.appendFileSync(eventsPath, "spawn\\n");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(eventsPath, "close\\n");
  process.exit(0);
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools });
  } else if (message.method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: message.params.name + "-ok" }] });
  }
});
`,
			"utf-8",
		);
		return serverPath;
	};
	const readLifecycle = (eventsPath: string) => readFileSync(eventsPath, "utf-8").split(/\r?\n/).filter(Boolean);

	it("returns no tools and no diagnostics when the config is missing", async () => {
		const result = await load();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reports an error diagnostic for malformed JSON", async () => {
		writeConfig("{ not json");
		const result = await load();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.type).toBe("error");
		expect(result.diagnostics[0]?.message).toContain("not valid JSON");
	});

	it("reports an error when the servers array is missing", async () => {
		writeConfig(JSON.stringify({ foo: "bar" }));
		const result = await load();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics[0]?.type).toBe("error");
		expect(result.diagnostics[0]?.message).toContain('"servers" array');
	});

	it("skips entries missing name or command with a warning", async () => {
		writeConfig(JSON.stringify({ servers: [{ name: "no-command" }, { command: "node" }] }));
		const result = await load();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics.every((d) => d.type === "warning")).toBe(true);
	});

	it("skips a duplicate server name with a warning without spawning it twice", async () => {
		// The first entry names a command that does not exist, so it fails to
		// connect (warning). The duplicate is skipped before any connect attempt.
		writeConfig(
			JSON.stringify({
				servers: [
					{ name: "dup", command: "/nonexistent/mcp-binary-xyz" },
					{ name: "dup", command: "/nonexistent/mcp-binary-xyz" },
				],
			}),
		);
		const result = await load();
		expect(result.tools).toEqual([]);
		const dupWarning = result.diagnostics.find((d) => d.message.includes("Duplicate MCP server name"));
		expect(dupWarning?.type).toBe("warning");
	});

	it("returns an empty toolset (no throw) when a server fails to connect", async () => {
		writeConfig(JSON.stringify({ servers: [{ name: "broken", command: "/nonexistent/mcp-binary-xyz" }] }));
		const result = await load();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics.some((d) => d.type === "warning" && d.message.includes("broken"))).toBe(true);
	});

	it("discovers a configured server through the selected managed process runtime", async () => {
		const serverPath = join(dir, "managed-mcp.cjs");
		writeFileSync(
			serverPath,
			`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "ping", description: "Managed ping", inputSchema: { type: "object" } }] });
  }
});
`,
			"utf-8",
		);
		writeConfig(
			JSON.stringify({
				servers: [{ name: "managed", command: process.execPath, args: [serverPath], name_prefix: "user" }],
			}),
		);

		const result = await load();
		expect(result.diagnostics).toEqual([]);
		expect(result.tools.map((tool) => tool.name)).toEqual(["user_ping"]);
		expect(result.addresses).toEqual(["tool:user_ping"]);
		expect(hcp.resolveInstance("tool:user_ping")).toMatchObject({ name: "user_ping" });
	});

	it("closes one shared user MCP connection when every sibling address collides", async () => {
		const originalClose = McpConnection.prototype.close;
		const terminalClose = vi.spyOn(McpConnection.prototype, "close").mockImplementation(async function (
			this: McpConnection,
		) {
			await originalClose.call(this);
			throw new Error("terminal close failed");
		});
		const lifecyclePath = join(dir, "all-collision-lifecycle.txt");
		const serverPath = writeLifecycleServer("all-colliding-mcp.cjs", lifecyclePath, ["read", "write"]);
		const originalRead = {
			name: "read",
			description: "Original read",
			parameters: {},
			execute: async () => ({ content: [{ type: "text" as const, text: "original-read" }], details: {} }),
		};
		const originalWrite = {
			name: "write",
			description: "Original write",
			parameters: {},
			execute: async () => ({ content: [{ type: "text" as const, text: "original-write" }], details: {} }),
		};
		const toolsServer = hcp.resolveModule("tools")!;
		hcp.registerModule(
			toolsServer,
			new Map([
				["tool:read", { kind: "fixture", source: "fixture", toTool: () => originalRead }],
				["tool:write", { kind: "fixture", source: "fixture", toTool: () => originalWrite }],
			]),
			{ merge: true },
		);
		writeConfig(
			JSON.stringify({
				servers: [{ name: "managed", command: process.execPath, args: [serverPath], name_prefix: "" }],
			}),
		);

		const result = await load();
		expect(result.tools).toEqual([]);
		expect(result.addresses).toEqual([]);
		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "error", message: expect.stringContaining('"tool:read"') }),
				expect.objectContaining({ type: "error", message: expect.stringContaining('"tool:write"') }),
			]),
		);
		expect(hcp.resolveInstance("tool:read")).toBe(originalRead);
		expect(hcp.resolveInstance("tool:write")).toBe(originalWrite);
		expect(readLifecycle(lifecyclePath)).toEqual(["spawn", "close"]);
		expect(terminalClose).toHaveBeenCalledTimes(1);

		await hcp.dispose();
		expect(readLifecycle(lifecyclePath)).toEqual(["spawn", "close"]);
	});

	it("keeps a non-colliding sibling on the original process until the Client is disposed", async () => {
		const terminalClose = vi.spyOn(McpConnection.prototype, "close");
		const lifecyclePath = join(dir, "partial-collision-lifecycle.txt");
		const serverPath = writeLifecycleServer("partially-colliding-mcp.cjs", lifecyclePath, ["read", "unique"]);
		const original = {
			name: "read",
			description: "Original read",
			parameters: {},
			execute: async () => ({ content: [{ type: "text" as const, text: "original" }], details: {} }),
		};
		const toolsServer = hcp.resolveModule("tools")!;
		hcp.registerModule(
			toolsServer,
			new Map([["tool:read", { kind: "fixture", source: "fixture", toTool: () => original }]]),
			{ merge: true },
		);
		writeConfig(
			JSON.stringify({
				servers: [{ name: "managed", command: process.execPath, args: [serverPath], name_prefix: "" }],
			}),
		);

		const result = await load();
		expect(result.addresses).toEqual(["tool:unique"]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ type: "error", message: expect.stringContaining("address collision") }),
		]);
		expect(hcp.resolveInstance("tool:read")).toBe(original);
		expect(readLifecycle(lifecyclePath)).toEqual(["spawn"]);
		const unique = hcp.resolveInstance<{
			execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
		}>("tool:unique");
		expect(unique).toBeDefined();
		const executed = await unique!.execute("call-id", {}, undefined, undefined, undefined);
		expect(executed.content).toEqual([{ type: "text", text: "unique-ok" }]);
		expect(readLifecycle(lifecyclePath)).toEqual(["spawn"]);
		expect(terminalClose).not.toHaveBeenCalled();

		await hcp.dispose();
		expect(readLifecycle(lifecyclePath)).toEqual(["spawn", "close"]);
		expect(terminalClose).toHaveBeenCalledTimes(1);
		await hcp.dispose();
		expect(readLifecycle(lifecyclePath)).toEqual(["spawn", "close"]);
	});

	it("skips an http server missing a url with a warning", async () => {
		writeConfig(JSON.stringify({ servers: [{ name: "remote", type: "http" }] }));
		const result = await load();
		expect(result.tools).toEqual([]);
		const warning = result.diagnostics.find((d) => d.message.includes('http MCP server "remote"'));
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain('missing "url"');
	});

	it("connects to a configured http server and surfaces its tools", async () => {
		const { createServer } = await import("node:http");
		const server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				const msg = JSON.parse(raw || "{}") as { id?: number; method?: string };
				if (msg.id === undefined) {
					res.statusCode = 202;
					res.end();
					return;
				}
				const result =
					msg.method === "initialize"
						? { protocolVersion: "2025-03-26", capabilities: { tools: {} } }
						: msg.method === "tools/list"
							? { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] }
							: { content: [{ type: "text", text: "pong" }] };
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		try {
			writeConfig(
				JSON.stringify({
					servers: [{ name: "remote", type: "http", url: `http://127.0.0.1:${port}/mcp`, name_prefix: "" }],
				}),
			);
			const result = await load();
			expect(result.addresses).toContain("tool:ping");
			expect(result.diagnostics.filter((d) => d.type === "error")).toEqual([]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("never serializes http headers into diagnostics (no token leak)", async () => {
		// Point at a closed port so the connection fails, forcing a diagnostic that
		// mentions the server; the secret header must not appear anywhere in it.
		writeConfig(
			JSON.stringify({
				servers: [
					{
						name: "remote",
						type: "http",
						url: "http://127.0.0.1:1/mcp",
						headers: { Authorization: "Bearer super-secret-token" },
						timeout_ms: 100,
					},
				],
			}),
		);
		const result = await load();
		const serialized = JSON.stringify(result.diagnostics);
		expect(serialized).not.toContain("super-secret-token");
	});
});
