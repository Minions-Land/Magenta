import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../assembly/hcp/hcp.ts";
import { createMagnetFromCatalogEntry } from "../assembly/magnet/factory.ts";
import { registerMagnetHcpServers } from "../assembly/magnet/hcp-registry.ts";
import { HcpProcessMagnet } from "../assembly/magnet/hcp-process.ts";
import { ProcessToolMagnet } from "../assembly/magnet/process.ts";
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
		expect(result.details.runtimePolicy).toMatchObject({
			network: "deny",
			os_enforced: false,
		});
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
		const target = magnet.toHcpServer();

		expect(target.describe().ops).toContain("disable");
		expect(await target.call({ target: "tool://ManagedTool", op: "disable" })).toMatchObject({ enabled: false });
		expect(await target.call({ target: "tool://ManagedTool", op: "health" })).toMatchObject({ status: "disabled" });
		expect(await target.call({ target: "tool://ManagedTool", op: "enable" })).toMatchObject({ enabled: true });
	});

	it("registers HcpMagnet management targets into HCP exactly once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-process-hcp-registry-"));
		const first = new ProcessToolMagnet({
			cwd: dir,
			manifestRoot: dir,
			manifest: {
				kind: "process",
				name: "ManagedOne",
				description: "Managed one",
				command: process.execPath,
				args: ["--version"],
			},
		});
		const duplicate = new ProcessToolMagnet({
			cwd: dir,
			manifestRoot: dir,
			manifest: {
				kind: "process",
				name: "ManagedOne",
				description: "Managed duplicate",
				command: process.execPath,
				args: ["--version"],
			},
		});
		const second = new HcpProcessMagnet({
			cwd: dir,
			manifest: {
				kind: "hcp-process",
				name: "managed-jsonl",
				description: "Managed JSONL",
				command: process.execPath,
				args: ["--version"],
			},
		});
		const hcp = new HcpClient();

		const result = registerMagnetHcpServers(hcp, [first, second]);
		expect(result.registrations.map((registration) => registration.target).sort()).toEqual([
			"hcp-process://managed-jsonl",
			"tool://ManagedOne",
		]);
		await expect(hcp.dispatch({ target: "tool://ManagedOne", op: "state" })).resolves.toMatchObject({
			enabled: true,
		});
		await expect(hcp.dispatch({ target: "hcp:registry", op: "addresses" })).resolves.toEqual([
			"tool://ManagedOne",
			"hcp-process://managed-jsonl",
		]);
		expect(() => registerMagnetHcpServers(hcp, [duplicate])).toThrow(/Duplicate HcpMagnet HCP target/);
		expect(registerMagnetHcpServers(hcp, [duplicate], { duplicates: "skip" }).skipped).toEqual([
			{ magnetKind: "process", reason: "duplicate", target: "tool://ManagedOne" },
		]);
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

	it("runs JSONL HCP processes through runtime://process policy", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-hcp-process-policy-"));
		const script = await writeExecutableScript(
			dir,
			"hcp-env-server.mjs",
			`#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    result: {
      allowed: process.env.MAGENTA_HCP_ALLOWED ?? null,
      blocked: process.env.MAGENTA_HCP_BLOCKED ?? null
    }
  }) + "\\n");
});
`,
		);
		const magnet = new HcpProcessMagnet({
			cwd: dir,
			env: {
				MAGENTA_HCP_ALLOWED: "yes",
				MAGENTA_HCP_BLOCKED: "no",
			},
			manifest: {
				kind: "hcp-process",
				name: "echo-env-jsonl",
				description: "Echo HCP JSONL env",
				command: process.execPath,
				args: [script],
				env_allowlist: ["PATH", "MAGENTA_HCP_ALLOWED"],
				max_wall_seconds: 30,
			},
		});

		await expect(magnet.toHcpServer().call({ target: "hcp-process://echo-env-jsonl", op: "health" })).resolves.toMatchObject({
			runtime: "runtime://process",
			envAllowlist: ["PATH", "MAGENTA_HCP_ALLOWED"],
			maxWallSeconds: 30,
		});
		await expect(
			magnet.send({
				id: "req-env",
				method: "call",
				target: "tool://Echo",
				op: "call",
			}),
		).resolves.toEqual({
			allowed: "yes",
			blocked: null,
		});
	});

	it("creates generic magnets from migrated Magenta1 catalog entries", async () => {
		const catalog = await loadHarnessComponentCatalog(
			"magenta1-harness-components",
			new URL("../catalog/magenta/magenta1-components-inventory.json", import.meta.url).pathname,
			{
				integrationMapPath: new URL("../catalog/magenta/magenta1-integration-map.json", import.meta.url).pathname,
			},
		);
		const astGrep = catalog.entries.find((entry) => entry.id === "general-harness:mcp:AstGrep");
		const hcpProcess = catalog.entries.find((entry) => entry.id === "general-harness:hcp-process:echo-jsonl");
		expect(astGrep).toBeDefined();
		expect(hcpProcess).toBeDefined();

		const processMagnet = await createMagnetFromCatalogEntry(catalog, astGrep!, { cwd: process.cwd() });
		const processTarget = processMagnet.toHcpServer?.();
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
			command: expect.stringContaining("harness/tools/grep/magenta/process-tools/target/release/magenta-process-tools"),
			runtime: "runtime://process",
		});

		const hcpMagnet = await createMagnetFromCatalogEntry(catalog, hcpProcess!, { cwd: process.cwd() });
		const hcpTarget = hcpMagnet.toHcpServer?.();
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
			new URL("../catalog/magenta/magenta1-components-inventory.json", import.meta.url).pathname,
			{
				integrationMapPath: new URL("../catalog/magenta/magenta1-integration-map.json", import.meta.url).pathname,
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
		expect(result.details.sandboxEnforced).toBe(true);
		expect(result.details.runtimePolicy).toMatchObject({
			network: "deny",
			os_enforced: false,
		});
	});
});
