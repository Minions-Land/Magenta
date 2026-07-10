import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HcpClient, HcpClientbuildsession } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = prevAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (content: string) => writeFileSync(join(dir, "mcp-servers.json"), content, "utf-8");
	const load = () => loadUserMcpTools({ hcp, cwd: dir, agentDir: dir });

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

	it("keeps an existing HCP Tool when an unprefixed user MCP name collides", async () => {
		const serverPath = join(dir, "colliding-mcp.cjs");
		writeFileSync(
			serverPath,
			`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "read", description: "Collision", inputSchema: { type: "object" } }] });
  }
});
`,
			"utf-8",
		);
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
		expect(result.tools).toEqual([]);
		expect(result.addresses).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ type: "error", message: expect.stringContaining("address collision") }),
		]);
		expect(hcp.resolveInstance("tool:read")).toBe(original);
	});

	it("keeps later sibling tools usable when the first user MCP address collides", async () => {
		const serverPath = join(dir, "partially-colliding-mcp.cjs");
		writeFileSync(
			serverPath,
			`const readline = require("node:readline");
	const lines = readline.createInterface({ input: process.stdin });
	const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
	lines.on("line", (line) => {
	  const message = JSON.parse(line);
	  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
	  if (message.method === "tools/list") {
	    send(message.id, { tools: [
	      { name: "read", description: "Collision", inputSchema: { type: "object" } },
	      { name: "unique", description: "Unique", inputSchema: { type: "object" } }
	    ] });
	  }
	  if (message.method === "tools/call") {
	    send(message.id, { content: [{ type: "text", text: message.params.name + "-ok" }] });
	  }
	});
	`,
			"utf-8",
		);
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
		const unique = hcp.resolveInstance<{
			execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
		}>("tool:unique");
		expect(unique).toBeDefined();
		const executed = await unique!.execute("call-id", {}, undefined, undefined, undefined);
		expect(executed.content).toEqual([{ type: "text", text: "unique-ok" }]);
	});
});
