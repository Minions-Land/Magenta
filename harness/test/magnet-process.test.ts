import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerMagnetHcpServers } from "../harness-component-protocol/assembly/register-servers.ts";
import { HcpClient } from "../harness-component-protocol/HcpClient.ts";
import { HcpMagnetProcess } from "../hcp-magnet/hcp-process.ts";
import { ProcessToolMagnet, processToolManifestFromToml } from "../hcp-magnet/process.ts";

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

	it("propagates manifest render_kind onto the AgentTool for host-side rendering", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-process-renderkind-"));
		const withKind = new ProcessToolMagnet({
			cwd: dir,
			manifestRoot: dir,
			manifest: {
				kind: "process",
				name: "SearchTool",
				description: "Search test tool",
				command: process.execPath,
				args: ["--version"],
				render_kind: "search-results",
			},
		});
		expect(withKind.toTool().renderKind).toBe("search-results");

		const withoutKind = new ProcessToolMagnet({
			cwd: dir,
			manifestRoot: dir,
			manifest: {
				kind: "process",
				name: "PlainTool",
				description: "Plain test tool",
				command: process.execPath,
				args: ["--version"],
			},
		});
		expect(withoutKind.toTool().renderKind).toBeUndefined();
	});

	it("parses render_kind from a TOML manifest table", () => {
		const withKind = processToolManifestFromToml({
			name: "WebSearch",
			description: "Search the web",
			command: "bin/tool",
			render_kind: "search-results",
		});
		expect(withKind.render_kind).toBe("search-results");

		const withoutKind = processToolManifestFromToml({
			name: "Plain",
			description: "Plain tool",
			command: "bin/tool",
		});
		expect(withoutKind.render_kind).toBeUndefined();
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
		const second = new HcpMagnetProcess({
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
		const magnet = new HcpMagnetProcess({
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
		const magnet = new HcpMagnetProcess({
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

		await expect(
			magnet.toHcpServer().call({ target: "hcp-process://echo-env-jsonl", op: "health" }),
		).resolves.toMatchObject({
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
});
