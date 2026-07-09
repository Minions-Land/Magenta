import { describe, expect, it } from "vitest";
import { HcpClient } from "../harness-component-protocol/HcpClient.ts";
import { getHarnessRegistryPath, loadRegistry } from "../harness-component-protocol/registry/registry.ts";
import { HcpMagnet as HookMagentaMagnet } from "../modules/hooks/magenta/HcpMagnet.ts";
import { HookProvider } from "../modules/hooks/magenta/hooks.ts";

describe("hook provider", () => {
	it("discovers and describes migrated lifecycle hooks", async () => {
		const provider = new HookProvider();

		expect(provider.discover()).toMatchObject({
			provider: "hooks",
			targets: expect.arrayContaining([
				"hook://init",
				"hook://pre-tool",
				"hook://workflow",
				"hook://sandbox-select",
			]),
			lifecycle_targets: expect.arrayContaining(["hook://init", "hook://pre-tool", "hook://workflow"]),
		});
		expect(provider.describeHook("pre-tool")).toMatchObject({
			name: "pre-tool",
			target: "hook://pre-tool",
		});
	});

	it("runs pre-tool hook as declarative sandbox/approval/shell-policy actions", async () => {
		const magnet = new HookMagentaMagnet({ repoRoot: process.cwd(), packagesRoot: process.cwd(), kind: "hook", name: "hook", descriptorPath: "", source: "magenta" });
		const hcp = new HcpClient().register("hook", magnet.toHcpServer());

		await expect(
			hcp.dispatch({
				target: "hook://pre-tool",
				op: "run",
				input: {
					tool: { name: "bash", operation: "write", tags: ["shell", "workspace-write"] },
					input: { command: "rm -rf tmp" },
				},
			}),
		).resolves.toMatchObject({
			hook: "pre-tool",
			status: "ok",
			return_mode: "steer",
			actions: [
				{ type: "sandbox", target: "hook://sandbox-select", output: { profile: "workspace-write" } },
				{ type: "hcp_call", target: "approval://policy", op: "decide", output: { decision: "allow" } },
				{ type: "hcp_call", target: "shell://policy", op: "classify", output: { decision: "allow" } },
			],
			data: {
				sandbox: { profile: "workspace-write" },
				approval: { decision: "allow" },
				shell_policy: { decision: "allow" },
			},
		});
	});

	it("runs init and workflow hooks as action envelopes", async () => {
		const magnet = new HookMagentaMagnet({ repoRoot: process.cwd(), packagesRoot: process.cwd(), kind: "hook", name: "hook", descriptorPath: "", source: "magenta" });
		const hcp = new HcpClient().register("hook", magnet.toHcpServer());

		await expect(
			hcp.dispatch({
				target: "hook://init",
				op: "run",
				input: { session: "session-1" },
			}),
		).resolves.toMatchObject({
			hook: "init",
			return_mode: "follow_up",
			actions: [
				{
					type: "hcp_call",
					target: "session://current",
					op: "append_event",
					input: { kind: "session_initialized", data: { session: "session-1" } },
				},
			],
		});

		await expect(
			hcp.dispatch({
				target: "hook://workflow",
				op: "run",
				input: { target: "loop://custom", op: "resume", input: { id: "job-1" } },
			}),
		).resolves.toMatchObject({
			hook: "workflow",
			return_mode: "next_turn",
			actions: [
				{
					type: "hcp_call",
					target: "loop://custom",
					op: "resume",
					input: { id: "job-1" },
					purpose: "workflow_dispatch",
				},
			],
		});
	});
});
