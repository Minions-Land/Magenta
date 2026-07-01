import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMagnetFromCatalogEntry } from "../assembly/magnet/pi/factory.ts";
import { HcpProcessMagnet } from "../assembly/magnet/pi/hcp-process.ts";
import { ProcessToolMagnet } from "../assembly/magnet/pi/process.ts";
import { loadHarnessComponentCatalog } from "../catalog/pi/catalog.ts";

async function writeExecutableScript(dir: string, name: string, source: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, source, { mode: 0o755 });
	return path;
}

describe("process magnets", () => {
	it("wraps a Magenta1-style process tool as an AgentTool", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-process-tool-"));
		const script = await writeExecutableScript(
			dir,
			"echo-tool.mjs",
			`#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(input || "{}");
  process.stdout.write("echo:" + parsed.message);
});
`,
		);
		const magnet = new ProcessToolMagnet({
			cwd: dir,
			manifestRoot: dir,
			manifest: {
				kind: "process",
				name: "EchoTool",
				description: "Echo test tool",
				command: process.execPath,
				args: [script],
				parameters: {
					type: "object",
					required: ["message"],
					properties: { message: { type: "string" } },
				},
			},
		});

		const tool = magnet.toTool();
		const result = await tool.execute("call-1", { message: "hello" });

		expect(tool.name).toBe("EchoTool");
		expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
		expect(result.details.status).toBe(0);
	});

	it("exposes a common HCP management surface", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-process-hcp-"));
		const magnet = new ProcessToolMagnet({
			cwd: dir,
			manifestRoot: dir,
			manifest: {
				kind: "process",
				name: "ManagedTool",
				description: "Managed test tool",
				command: process.execPath,
				args: ["--version"],
			},
		});
		const target = magnet.toHcpTarget();

		expect(target.describe().ops).toContain("disable");
		expect(await target.call({ target: "tool://ManagedTool", op: "disable" })).toMatchObject({ enabled: false });
		expect(await target.call({ target: "tool://ManagedTool", op: "health" })).toMatchObject({ status: "disabled" });
		expect(await target.call({ target: "tool://ManagedTool", op: "enable" })).toMatchObject({ enabled: true });
	});

	it("proxies a JSONL HCP process", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-hcp-process-"));
		const script = await writeExecutableScript(
			dir,
			"hcp-server.mjs",
			`#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    result: { type: "output", value: { method: request.method, target: request.target, input: request.input } }
  }) + "\\n");
});
`,
		);
		const magnet = new HcpProcessMagnet({
			cwd: dir,
			manifest: {
				kind: "hcp-process",
				name: "echo-jsonl",
				description: "Echo HCP JSONL",
				command: process.execPath,
				args: [script],
			},
		});

		const result = await magnet.send({
			id: "req-1",
			method: "call",
			target: "tool://Echo",
			op: "call",
			input: { message: "hello" },
		});

		expect(result).toEqual({
			type: "output",
			value: {
				method: "call",
				target: "tool://Echo",
				input: { message: "hello" },
			},
		});
	});

	it("creates generic magnets from migrated Magenta1 catalog entries", async () => {
		const catalog = await loadHarnessComponentCatalog(
			"magenta1-harness-components",
			new URL("../catalog/magenta1-components-inventory.json", import.meta.url).pathname,
			{
				integrationMapPath: new URL("../catalog/magenta1-integration-map.json", import.meta.url).pathname,
			},
		);
		const astGrep = catalog.entries.find((entry) => entry.id === "general-harness:mcp:AstGrep");
		const hcpProcess = catalog.entries.find((entry) => entry.id === "general-harness:hcp-process:echo-jsonl");
		expect(astGrep).toBeDefined();
		expect(hcpProcess).toBeDefined();

		const processMagnet = await createMagnetFromCatalogEntry(catalog, astGrep!, { cwd: process.cwd() });
		const processTarget = processMagnet.toHcpTarget?.();
		expect(processTarget).toBeDefined();
		const processDescription = processTarget?.describe();
		expect(processDescription).toMatchObject({
			target: "tool://AstGrep",
			kind: "tool",
		});
		expect(processDescription?.metadata).toMatchObject({
			implementation: "process",
			toolName: "AstGrep",
		});
		await expect(processTarget!.call({ target: "tool://AstGrep", op: "health" })).resolves.toMatchObject({
			command: expect.stringContaining("harness/process-tools/target/release/magenta-process-tools"),
		});

		const hcpMagnet = await createMagnetFromCatalogEntry(catalog, hcpProcess!, { cwd: process.cwd() });
		const hcpTarget = hcpMagnet.toHcpTarget?.();
		expect(hcpTarget).toBeDefined();
		expect(hcpTarget?.describe()).toMatchObject({
			target: "hcp-process://echo-jsonl",
			kind: "hcp-process",
		});
	});

	it("executes a migrated process tool from the catalog", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-rust-process-tool-"));
		const catalog = await loadHarnessComponentCatalog(
			"magenta1-harness-components",
			new URL("../catalog/magenta1-components-inventory.json", import.meta.url).pathname,
			{
				integrationMapPath: new URL("../catalog/magenta1-integration-map.json", import.meta.url).pathname,
			},
		);
		const echoJson = catalog.entries.find((entry) => entry.id === "general-harness:mcp:echo-json");
		expect(echoJson).toBeDefined();

		const magnet = await createMagnetFromCatalogEntry(catalog, echoJson!, { cwd: dir });
		const tool = magnet.toTool?.();
		expect(tool).toBeDefined();

		const result = await tool!.execute("call-echo-json", { message: "hello" });
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		expect(firstContent?.type === "text" ? firstContent.text : "").toContain('"message":"hello"');
	});
});
