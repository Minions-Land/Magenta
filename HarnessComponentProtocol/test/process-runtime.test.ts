import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../HcpClient.ts";
import * as runtimeServer from "../runtime/HcpServer.ts";
import * as runtimeMagenta from "../runtime/magenta/HcpMagnet.ts";
import { execProcess, ProcessRuntimeProvider } from "../runtime/magenta/process-runtime.ts";
import { loadSandboxProviderFromPack } from "../sandbox/magenta/sandbox.ts";

async function writeExecutableScript(dir: string, name: string, source: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, source, { mode: 0o755 });
	return path;
}

describe("process runtime provider", () => {
	it("executes through runtime://process with env allowlist and policy report", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-"));
		const provider = await loadSandboxProviderFromPack(new URL("../sandbox/sandbox.toml", import.meta.url).pathname);
		const script = await writeExecutableScript(
			dir,
			"env-tool.mjs",
			`#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    input: JSON.parse(input || "{}"),
    allowed: process.env.MAGENTA_TEST_ALLOWED ?? null,
    blocked: process.env.MAGENTA_TEST_BLOCKED ?? null
  }));
});
`,
		);
		const output = await execProcess({
			command: process.execPath,
			args: [script],
			stdin_json: { message: "hello" },
			cwd: dir,
			workspace_root: dir,
			sandbox: {
				profile: {
					...provider.get("restricted"),
					env_allowlist: [...provider.get("restricted").env_allowlist, "MAGENTA_TEST_ALLOWED"],
				},
			},
			tool: { name: "EnvTool", operation: "read", read_only: true, tags: [] },
			env_overrides: {
				MAGENTA_TEST_ALLOWED: "yes",
				MAGENTA_TEST_BLOCKED: "no",
			},
		});

		expect(JSON.parse(output.stdout)).toEqual({
			input: { message: "hello" },
			allowed: "yes",
			blocked: "no",
		});
		expect(output.policy).toMatchObject({
			network: "deny",
			os_enforced: false,
		});
	});

	it("requires tool metadata unless direct exec is explicitly allowed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-direct-"));
		await expect(
			execProcess({
				command: process.execPath,
				args: ["--version"],
				cwd: dir,
				workspace_root: dir,
			}),
		).rejects.toThrow(/direct exec requires tool metadata/);
	});

	it("enforces workspace path and network portable guards", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-policy-"));
		const provider = await loadSandboxProviderFromPack(new URL("../sandbox/sandbox.toml", import.meta.url).pathname);

		await expect(
			execProcess({
				command: process.execPath,
				args: ["--version"],
				cwd: dir,
				workspace_root: dir,
				sandbox: { profile: provider.get("readonly-fs") },
				tool: { name: "WriteTool", operation: "write", tags: ["workspace-write"] },
				stdin_json: { file_path: "out.txt" },
			}),
		).rejects.toThrow(/sandbox denied write access/);

		await expect(
			execProcess({
				command: process.execPath,
				args: ["--version"],
				cwd: dir,
				workspace_root: dir,
				sandbox: { profile: provider.get("restricted") },
				tool: { name: "FetchTool", operation: "read", tags: ["network", "fetch"] },
				stdin_json: { url: "https://example.com" },
			}),
		).rejects.toThrow(/network-tagged tool cannot run with network=deny/);

		await expect(
			execProcess({
				command: process.execPath,
				args: ["--version"],
				cwd: "..",
				workspace_root: dir,
				sandbox: { profile: provider.get("restricted") },
				tool: { name: "BadCwd", operation: "read", tags: [] },
			}),
		).rejects.toThrow(/parent traversal/);
	});

	it("honors per-invocation timeout overrides", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-timeout-"));

		await expect(
			execProcess({
				command: process.execPath,
				args: ["-e", "setTimeout(() => {}, 1000)"],
				cwd: dir,
				workspace_root: dir,
				tool: { name: "SlowTool", operation: "read", tags: [] },
				timeout_ms: 10,
			}),
		).rejects.toThrow(/process exceeded sandbox wall time/);
	});

	it("manages a long-lived stdio process through write, output, exit, and close", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-managed-"));
		const script = await writeExecutableScript(
			dir,
			"managed.mjs",
			`#!/usr/bin/env node
import readline from "node:readline";
process.stderr.write("ready\\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => process.stdout.write(line.toUpperCase() + "\\n"));
`,
		);
		const provider = new ProcessRuntimeProvider();
		const managed = await provider.spawnManaged({
			command: process.execPath,
			args: [script],
			cwd: dir,
			workspace_root: dir,
			allow_direct_exec: true,
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		let resolveOutput!: () => void;
		const output = new Promise<void>((resolvePromise) => {
			resolveOutput = resolvePromise;
		});
		managed.onStdoutLine((line) => {
			stdout.push(line);
			if (stdout.length === 2) resolveOutput();
		});
		managed.onStderr((chunk) => stderr.push(chunk));

		await managed.write("first\nsecond\n");
		await output;
		expect(stdout).toEqual(["FIRST", "SECOND"]);
		expect(stderr.join("")).toContain("ready");

		await managed.close();
		await expect(managed.exit).resolves.toMatchObject({ reason: "close" });
		await expect(managed.write("late\n")).rejects.toThrow(/not writable/);
	});

	it("terminates a managed process when its AbortSignal fires", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-managed-abort-"));
		const controller = new AbortController();
		const managed = await new ProcessRuntimeProvider().spawnManaged(
			{
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cwd: dir,
				workspace_root: dir,
				allow_direct_exec: true,
			},
			controller.signal,
		);

		controller.abort();
		await expect(managed.exit).resolves.toMatchObject({
			reason: "abort",
			error: expect.objectContaining({ message: "Operation aborted" }),
		});
	});

	it("dispatches through HCP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-runtime-hcp-"));
		const magnet = new runtimeMagenta.HcpMagnet({
			kind: "runtime",
			name: "process",
			source: "magenta",
			repoRoot: process.cwd(),
			packagesRoot: process.cwd(),
		});
		const hcp = new HcpClient();
		hcp.registerModule(new runtimeServer.HcpServer(), new Map([["runtime:process", magnet]]));

		await expect(hcp.dispatch({ target: "runtime://process", op: "policy" })).resolves.toMatchObject({
			production_audit: { os_egress_allowlist: false },
		});
		await expect(
			hcp.dispatch({
				target: "runtime://process",
				op: "exec",
				input: {
					command: process.execPath,
					args: ["--version"],
					cwd: dir,
					workspace_root: dir,
					allow_direct_exec: true,
				},
			}),
		).resolves.toMatchObject({
			status: 0,
			policy: { resolved_backend: "none" },
		});
	});
});
