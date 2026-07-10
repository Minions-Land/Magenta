import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpMagnetProcess } from "../.HCP/transport/hcp-process.ts";
import { HcpClient } from "../HcpClient.ts";
import { execProcess } from "../runtime/magenta/process-runtime.ts";
import { HcpMagnet as DescriptorHcpMagnet } from "../tools/descriptor/HcpMagnet.ts";
import * as toolsServer from "../tools/HcpServer.ts";
import { ProcessTool, processToolManifestFromToml } from "../tools/process-tool.ts";

async function writeExecutableScript(dir: string, name: string, source: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, source, { mode: 0o755 });
	return path;
}

describe("process tool transports", () => {
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
		const magnet = new ProcessTool({
			runtimeExec: execProcess,
			sandbox: {
				selection: {
					profile: "restricted",
					reason: {
						read_only: false,
						destructive: false,
						trusted: false,
						network_read: false,
						workspace_write: true,
					},
				},
				profile: {
					kind: "sandbox",
					name: "restricted",
					description: "test",
					fs_read: ["."],
					fs_write: ["."],
					network: "deny",
					network_allowlist: [],
					max_memory_mb: 0,
					max_wall_seconds: 0,
					env_allowlist: ["PATH"],
					backend: "auto",
				},
			},
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
		const withKind = new ProcessTool({
			runtimeExec: execProcess,
			sandbox: testSandbox(),
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

		const withoutKind = new ProcessTool({
			runtimeExec: execProcess,
			sandbox: testSandbox(),
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

	it("is managed by the real tools HcpServer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-process-hcp-"));
		const product = new ProcessTool({
			runtimeExec: execProcess,
			sandbox: testSandbox(),
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
		const source = new DescriptorHcpMagnet(product);
		const hcp = new HcpClient();
		hcp.registerModule(new toolsServer.HcpServer(), new Map([["tool:ManagedTool", source]]));

		expect((source as { toHcpServer?: unknown }).toHcpServer).toBeUndefined();
		await expect(hcp.dispatch({ target: "tool:ManagedTool", op: "describe" })).resolves.toMatchObject({
			target: "tool:ManagedTool",
			kind: "tool",
			metadata: { implementation: "process", source: "descriptor" },
		});
		expect(hcp.resolveInstance<{ name: string }>("tool:ManagedTool")?.name).toBe("ManagedTool");
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
		const transport = new HcpMagnetProcess({
			runtimeExec: execProcess,
			cwd: dir,
			manifest: {
				kind: "hcp-process",
				name: "echo-jsonl",
				description: "Echo HCP JSONL",
				command: process.execPath,
				args: [script],
			},
		});

		const result = await transport.send({
			id: "req-1",
			method: "call",
			target: "tool:Echo",
			op: "call",
			input: { message: "hello" },
		});

		expect(result).toEqual({
			type: "output",
			value: {
				method: "call",
				target: "tool:Echo",
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
		const transport = new HcpMagnetProcess({
			runtimeExec: execProcess,
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

		expect(transport.health()).toMatchObject({
			runtime: "runtime://process",
			envAllowlist: ["PATH", "MAGENTA_HCP_ALLOWED"],
			maxWallSeconds: 30,
		});
		await expect(
			transport.send({
				id: "req-env",
				method: "call",
				target: "tool:Echo",
				op: "call",
			}),
		).resolves.toEqual({
			allowed: "yes",
			blocked: null,
		});
	});
});

function testSandbox() {
	return {
		selection: {
			profile: "restricted",
			reason: { read_only: false, destructive: false, trusted: false, network_read: false, workspace_write: true },
		},
		profile: {
			kind: "sandbox" as const,
			name: "restricted",
			description: "test",
			fs_read: ["."],
			fs_write: ["."],
			network: "deny",
			network_allowlist: [],
			max_memory_mb: 0,
			max_wall_seconds: 0,
			env_allowlist: ["PATH"],
			backend: "auto",
		},
	};
}
