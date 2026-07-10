import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../HcpClient.ts";
import type { ProcessExecInput, ProcessRuntimeExecutor } from "../runtime/HcpServer.ts";
import { HcpServer } from "../tools/lsp/HcpServer.ts";
import { HcpMagnet } from "../tools/lsp/magenta/HcpMagnet.ts";
import { createProcessToolFromDescriptor } from "../tools/process-tool.ts";

describe("LSP Magenta source", () => {
	it("resolves its command from the implementation manifest and registers tool:lsp", async () => {
		const root = await mkdtemp(join(tmpdir(), "magenta-lsp-source-"));
		const moduleRoot = join(root, "tools", "lsp");
		const manifestRoot = join(moduleRoot, "magenta");
		const command = join(manifestRoot, "bin", "fake-lsp");
		await mkdir(join(manifestRoot, "bin"), { recursive: true });
		await writeFile(
			join(moduleRoot, "lsp.toml"),
			`kind = "tool"
name = "lsp"
source = "magenta"

[source_config.magenta]
implementation_manifest = "magenta/lsp.toml"
`,
		);
		await writeFile(
			join(manifestRoot, "lsp.toml"),
			`kind = "process"
name = "Lsp"
description = "test lsp"
command = "./bin/fake-lsp"
args = ["lsp"]
operation = "read"
read_only = true
destructive = false
`,
		);
		await writeFile(command, "test");

		let invocation: ProcessExecInput | undefined;
		const runtimeExec: ProcessRuntimeExecutor = async (input) => {
			invocation = input;
			return {
				stdout: "ok",
				stderr: "",
				status: 0,
				truncated: { stdout: false, stderr: false },
				policy: {
					workspace_root: root,
					process_cwd: root,
					fs_read: [root],
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
		const processTool = await createProcessToolFromDescriptor({
			descriptorPath: join(moduleRoot, "lsp.toml"),
			source: "magenta",
			cwd: root,
			runtimeExec,
			sandboxResolve: () => ({
				selection: {
					profile: "restricted",
					reason: {
						read_only: true,
						destructive: false,
						trusted: false,
						network_read: false,
						workspace_write: false,
					},
				},
				profile: {
					kind: "sandbox",
					name: "restricted",
					description: "test",
					fs_read: [root],
					fs_write: [],
					network: "deny",
					network_allowlist: [],
					max_memory_mb: 0,
					max_wall_seconds: 0,
					env_allowlist: ["PATH"],
					backend: "none",
				},
			}),
		});
		const magnet = new HcpMagnet(processTool);
		const hcp = new HcpClient();

		expect(hcp.registerModule(new HcpServer(), new Map([["magenta", magnet]]))).toEqual(["tool:lsp"]);
		expect(hcp.resolve("tool:Lsp")).toBeUndefined();
		await hcp.resolveInstance<ReturnType<typeof processTool.toTool>>("tool:lsp")?.execute("call-1", {
			action: "status",
		});

		expect(invocation).toMatchObject({
			command,
			args: ["lsp"],
			cwd: root,
			workspace_root: root,
		});
	});
});
