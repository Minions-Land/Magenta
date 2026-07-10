import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import { loadPackageOverlay } from "../_magenta/packages/package-overlay.ts";

const MOCK_MCP_SERVER = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: [
      { name: "greet", description: "Greet by name", inputSchema: { type: "object" } },
      { name: "status", description: "Read status", inputSchema: { type: "object" } }
    ] });
  } else if (message.method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: "hello " + message.params.arguments.name }] });
    setImmediate(() => process.exit(0));
  }
});
`;

describe("package MCP HCP assembly", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("expands one server into single-product component entries on the session Client", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "package-mcp-hcp-"));
		roots.push(repoRoot);
		const packageRoot = join(repoRoot, "packages", "MockMcp");
		const harnessRoot = join(packageRoot, "harness");
		const toolsRoot = join(harnessRoot, "tools");
		await mkdir(toolsRoot, { recursive: true });
		const serverPath = join(toolsRoot, "mock-server.cjs");
		await writeFile(serverPath, MOCK_MCP_SERVER, { mode: 0o755 });
		await writeFile(
			join(packageRoot, "package.toml"),
			`schema_version = "magenta.package.v1"
id = "MockMcp"
name = "Mock MCP"
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
name = "mock_server"
path = "tools/mock-server.toml"
`,
		);
		await writeFile(
			join(toolsRoot, "mock-server.toml"),
			`kind = "tool"
name = "mock_server"
description = "Mock package MCP"
runtime = "mcp"
command = "./mock-server.cjs"
args = []
name_prefix = "bio"
`,
		);

		const overlay = await loadPackageOverlay({ repoRoot, selections: ["MockMcp"] });
		const assembled = await HcpClientbuildsession({ repoRoot, overlay });

		expect(assembled.diagnostics).toEqual([]);
		expect(assembled.packageToolAddresses.sort()).toEqual(["tool:bio_greet", "tool:bio_status"]);
		const greet = assembled.hcp.resolveInstance<AgentTool>("tool:bio_greet");
		expect(greet?.provenance).toMatchObject({ kind: "mcp", remoteTool: "greet" });
		await expect(greet!.execute("call-1", { name: "hcp" })).resolves.toMatchObject({
			content: [{ type: "text", text: "hello hcp" }],
		});
	});
});
