import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerProcessToolCommandOverride } from "../_magenta/process-tools/command-registry.ts";
import type { ProcessExecInput, ProcessRuntimeExecutor } from "../runtime/HcpServer.ts";
import { createProcessToolFromDescriptor, ProcessTool } from "../tools/process-tool.ts";

const STATIC_PROCESS_TOOLS_COMMAND = "../../../_magenta/process-tools/target/release/magenta-process-tools";

describe("process tool command overrides", () => {
	let root: string | undefined;
	const unregister: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of unregister.splice(0).reverse()) cleanup();
		if (root) rmSync(root, { force: true, recursive: true });
		root = undefined;
	});

	it("binds a static HCP manifest command to this process's content-addressed helper during assembly", async () => {
		root = mkdtempSync(join(tmpdir(), "magenta-process-command-override-"));
		const moduleRoot = join(root, "tools", "lsp");
		const manifestRoot = join(moduleRoot, "magenta");
		const descriptorPath = join(moduleRoot, "lsp.toml");
		const manifestPath = join(manifestRoot, "lsp.toml");
		const logicalCommand = join(root, "_magenta", "process-tools", "target", "release", "magenta-process-tools");
		const helperPath = join(root, ".magenta", "cache", "process-tools", "a".repeat(64), "magenta-process-tools");
		mkdirSync(dirname(helperPath), { recursive: true });
		mkdirSync(manifestRoot, { recursive: true });
		writeFileSync(helperPath, "immutable helper");
		writeFileSync(
			descriptorPath,
			`kind = "tool"
name = "lsp"
source = "magenta"

[source_config.magenta]
implementation_manifest = "magenta/lsp.toml"
`,
		);
		writeFileSync(
			manifestPath,
			`kind = "process"
name = "Lsp"
description = "test lsp"
command = "${STATIC_PROCESS_TOOLS_COMMAND}"
args = ["lsp"]
`,
		);
		unregister.push(registerProcessToolCommandOverride(logicalCommand, helperPath));
		let invocation: ProcessExecInput | undefined;
		const processTool = await createProcessToolFromDescriptor({
			descriptorPath,
			source: "magenta",
			cwd: root,
			runtimeExec: capturingRuntime((input) => {
				invocation = input;
			}),
			sandboxResolve: testSandbox,
		});

		await processTool.toTool().execute("call-1", {});

		expect(invocation?.command).toBe(helperPath);
		expect(invocation?.command).not.toBe(logicalCommand);
	});

	it("keeps an explicit commandOverride authoritative over a registered default", async () => {
		root = mkdtempSync(join(tmpdir(), "magenta-process-explicit-override-"));
		const manifestRoot = join(root, "tools", "lsp", "magenta");
		const logicalCommand = join(root, "_magenta", "process-tools", "target", "release", "magenta-process-tools");
		const registeredPath = join(root, "cache", "registered-helper");
		const explicitPath = join(root, "cache", "explicit-helper");
		mkdirSync(dirname(registeredPath), { recursive: true });
		writeFileSync(registeredPath, "registered helper");
		writeFileSync(explicitPath, "explicit helper");
		unregister.push(registerProcessToolCommandOverride(logicalCommand, registeredPath));
		let invocation: ProcessExecInput | undefined;
		const processTool = new ProcessTool({
			manifest: {
				kind: "process",
				name: "lsp",
				description: "test lsp",
				command: STATIC_PROCESS_TOOLS_COMMAND,
			},
			manifestRoot,
			commandOverride: explicitPath,
			cwd: root,
			runtimeExec: capturingRuntime((input) => {
				invocation = input;
			}),
			sandbox: testSandbox(),
		});

		await processTool.toTool().execute("call-1", {});

		expect(invocation?.command).toBe(explicitPath);
	});
});

function capturingRuntime(capture: (input: ProcessExecInput) => void): ProcessRuntimeExecutor {
	return async (input) => {
		capture(input);
		return {
			stdout: "ok",
			stderr: "",
			status: 0,
			truncated: { stdout: false, stderr: false },
			policy: {
				workspace_root: input.workspace_root ?? input.cwd ?? process.cwd(),
				process_cwd: input.cwd ?? process.cwd(),
				fs_read: [],
				fs_write: [],
				network: "deny",
				network_allowlist: [],
				max_wall_seconds: 0,
				max_memory_mb: 0,
				backend: "none",
				resolved_backend: "none",
				os_enforced: false,
				backend_reason: "test",
			},
		};
	};
}

function testSandbox() {
	return {
		selection: {
			profile: "restricted",
			reason: { read_only: true, destructive: false, trusted: false, network_read: false, workspace_write: false },
		},
		profile: {
			kind: "sandbox" as const,
			name: "restricted",
			description: "test",
			fs_read: ["."],
			fs_write: [],
			network: "deny",
			network_allowlist: [],
			max_memory_mb: 0,
			max_wall_seconds: 0,
			env_allowlist: ["PATH"],
			backend: "none",
		},
	};
}
