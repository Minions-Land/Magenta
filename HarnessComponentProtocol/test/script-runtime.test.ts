import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClientassemble } from "../.HCP/assembly/session-hcp.ts";
import { HcpClient } from "../HcpClient.ts";
import * as runtimeServer from "../runtime/HcpServer.ts";
import { ScriptRuntimeProvider } from "../runtime/magenta/script-runtime.ts";
import { loadSandboxProviderFromPack } from "../sandbox/magenta/sandbox.ts";

async function assembleRuntime(): Promise<HcpClient> {
	const hcp = new HcpClient();
	const result = await HcpClientassemble({
		hcp,
		repoRoot: process.cwd(),
		includeAutoload: false,
		modules: ["runtime"],
	});

	expect(result.diagnostics).toEqual([]);
	expect(hcp.resolveModule("runtime")).toBeInstanceOf(runtimeServer.HcpServer);
	expect(hcp.resolve("capability:runtime:process")).toBe(hcp.resolveModule("runtime"));
	expect(hcp.resolve("capability:runtime:script-runtimes")).toBe(hcp.resolveModule("runtime"));
	expect(hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
	return hcp;
}

describe("script runtime provider", () => {
	it("describes the portable guard scope without claiming OS or native-tool enforcement", async () => {
		const hcp = await assembleRuntime();

		expect(hcp.describeAll().find(({ target }) => target === "capability:runtime:process")).toMatchObject({
			metadata: {
				osEnforcement: false,
				consumerScope: "explicit-runtime:process-callers",
				universalNativeToolEnforcement: false,
			},
		});
		await hcp.dispose();
	});

	it("discovers and describes Magenta1 runtime wrappers", async () => {
		const provider = new ScriptRuntimeProvider(async () => {
			throw new Error("not used by discovery");
		});

		expect(provider.discover()).toMatchObject({
			provider: "script-runtime",
			targets: ["runtime://shell", "runtime://python", "runtime://node", "runtime://r", "runtime://julia"],
			compiled_to: "runtime://process",
		});
		expect(provider.describeRuntime("python")).toMatchObject({
			name: "python",
			target: "runtime://python",
			command: "python3",
			compiled_to: "runtime://process",
		});
	});

	it("executes shell and node code through runtime://process", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-script-runtime-"));
		const sandbox = await loadSandboxProviderFromPack(new URL("../sandbox/sandbox.toml", import.meta.url).pathname);
		const hcp = await assembleRuntime();

		await expect(
			hcp.dispatch({
				target: "runtime://shell",
				op: "exec",
				input: {
					code: "printf shell:$1",
					args: ["ok"],
					cwd: dir,
					workspace_root: dir,
					sandbox: { profile: sandbox.get("restricted") },
					tool: { name: "ShellRuntime", operation: "read", tags: [] },
				},
			}),
		).resolves.toMatchObject({
			stdout: "shell:ok",
			runtime: "shell",
			compiled_to: "runtime://process",
			policy: { os_enforced: false },
		});

		await expect(
			hcp.dispatch({
				target: "runtime://node",
				op: "exec",
				input: {
					code: "process.stdout.write('node:' + JSON.parse(process.argv[1]).message)",
					args: [JSON.stringify({ message: "ok" })],
					cwd: dir,
					workspace_root: dir,
					sandbox: { profile: sandbox.get("restricted") },
					tool: { name: "NodeRuntime", operation: "read", tags: [] },
				},
			}),
		).resolves.toMatchObject({
			stdout: "node:ok",
			runtime: "node",
			compiled_to: "runtime://process",
		});
	});

	it("rejects empty script runtime input", async () => {
		const hcp = await assembleRuntime();

		await expect(
			hcp.dispatch({
				target: "runtime://node",
				op: "exec",
				input: { code: " " },
			}),
		).rejects.toThrow(/non-empty code/);
	});

	it("passes timeout overrides through to runtime://process", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-script-runtime-timeout-"));
		const hcp = await assembleRuntime();

		await expect(
			hcp.dispatch({
				target: "runtime://node",
				op: "exec",
				input: {
					code: "setTimeout(() => {}, 1000)",
					cwd: dir,
					workspace_root: dir,
					tool: { name: "SlowScriptRuntime", operation: "read", tags: [] },
					timeout_ms: 10,
				},
			}),
		).rejects.toThrow(/process exceeded sandbox wall time/);
	});
});
