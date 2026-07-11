import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import { loadPackageOverlay } from "../_magenta/packages/package-overlay.ts";

const MOCK_MCP_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.on("SIGTERM", () => {
  if (process.env.CLOSE_MARKER) fs.writeFileSync(process.env.CLOSE_MARKER, "closed");
  process.exit(0);
});
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

function countMcpToolConstructions(source: string, fileName: string): number {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let count = 0;
	const visit = (node: ts.Node): void => {
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "McpTool") {
			count += 1;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return count;
}

async function writeMcpPackage(repoRoot: string, closeMarker?: string) {
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
${closeMarker ? `\n[env]\nCLOSE_MARKER = ${JSON.stringify(closeMarker)}\n` : ""}`,
	);
	return loadPackageOverlay({ repoRoot, selections: ["MockMcp"] });
}

describe("package MCP HCP assembly", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("does not prebuild MCP products in Package or user assembly inputs", async () => {
		const descriptorPath = new URL("../tools/descriptor/HcpMagnet.ts", import.meta.url);
		const packageFactoryPath = new URL("../tools/descriptor/package-tool.ts", import.meta.url);
		const userLoaderPath = new URL("../../pi/coding-agent/src/core/mcp-config-loader.ts", import.meta.url);
		const [descriptorSource, packageFactorySource, userLoaderSource] = await Promise.all([
			readFile(descriptorPath, "utf-8"),
			readFile(packageFactoryPath, "utf-8"),
			readFile(userLoaderPath, "utf-8"),
		]);

		expect(countMcpToolConstructions(descriptorSource, descriptorPath.pathname)).toBe(1);
		expect(countMcpToolConstructions(packageFactorySource, packageFactoryPath.pathname)).toBe(0);
		expect(countMcpToolConstructions(userLoaderSource, userLoaderPath.pathname)).toBe(0);
		expect(packageFactorySource).not.toContain("settings.product");
		expect(userLoaderSource).not.toContain("settings: product");
	});

	it("expands one server into single-product component entries on the session Client", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "package-mcp-hcp-"));
		roots.push(repoRoot);
		const overlay = await writeMcpPackage(repoRoot);
		const assembled = await HcpClientbuildsession({ repoRoot, overlay });

		expect(assembled.diagnostics).toEqual([]);
		expect(assembled.packageToolAddresses.sort()).toEqual(["tool:bio_greet", "tool:bio_status"]);
		const greet = assembled.hcp.resolveInstance<AgentTool>("tool:bio_greet");
		expect(greet?.provenance).toMatchObject({ kind: "mcp", remoteTool: "greet" });
		await expect(greet!.execute("call-1", { name: "hcp" })).resolves.toMatchObject({
			content: [{ type: "text", text: "hello hcp" }],
		});
		await assembled.hcp.dispose();
	});

	it("disposes the partial Client and MCP connection when a progress callback throws", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "package-mcp-rollback-"));
		roots.push(repoRoot);
		const closeMarker = join(repoRoot, "mcp-closed.txt");
		const overlay = await writeMcpPackage(repoRoot, closeMarker);

		await expect(
			HcpClientbuildsession({
				repoRoot,
				overlay,
				onPackageAssemblyProgress: (progress) => {
					if (progress.phase === "assembled") throw new Error("stop after assembly");
				},
			}),
		).rejects.toThrow("stop after assembly");
		await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed");
	});
});
