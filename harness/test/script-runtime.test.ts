import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../hcp-client/hcp-client.ts";
import { getHarnessRegistryPath, loadRegistry } from "../hcp-client/registry/registry.ts";
import { ScriptRuntimeProvider } from "../modules/runtime/magenta/script-runtime.ts";
import { loadSandboxProviderFromPack } from "../modules/sandbox/magenta/sandbox.ts";

describe("script runtime provider", () => {
	it("discovers and describes Magenta1 runtime wrappers", async () => {
		const provider = new ScriptRuntimeProvider();

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
		const sandbox = await loadSandboxProviderFromPack(
			new URL("../modules/sandbox/sandbox.toml", import.meta.url).pathname,
		);
		const hcp = new HcpClient().register("runtime", new ScriptRuntimeProvider().toHcpServer());

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
		const hcp = new HcpClient().register("runtime", new ScriptRuntimeProvider().toHcpServer());

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
		const hcp = new HcpClient().register("runtime", new ScriptRuntimeProvider().toHcpServer());

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
