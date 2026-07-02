import { describe, expect, it } from "vitest";
import { HcpRegistry } from "../assembly/hcp/pi/hcp.ts";
import { getHarnessRegistryPath, loadRegistry } from "../assembly/registry/pi/registry.ts";
import { HookProvider } from "../hooks/magenta/hooks.ts";

describe("hook provider", () => {
	it("discovers and describes migrated lifecycle hooks", async () => {
		const provider = new HookProvider();

		expect(provider.discover()).toMatchObject({
			provider: "hooks",
			targets: expect.arrayContaining(["hook://init", "hook://pre-tool", "hook://workflow", "hook://sandbox-select"]),
			lifecycle_targets: expect.arrayContaining(["hook://init", "hook://pre-tool", "hook://workflow"]),
		});
		expect(provider.describeHook("pre-tool")).toMatchObject({
			name: "pre-tool",
			target: "hook://pre-tool",
		});
	});

	it("runs pre-tool hook as declarative sandbox/approval/shell-policy actions", async () => {
		const hcp = new HcpRegistry().register("hook", new HookProvider().toHcpTarget());

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
		const hcp = new HcpRegistry().register("hook", new HookProvider().toHcpTarget());

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

	it("registers hook entries in the catalog map", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const catalog = registry.catalogs[0]?.catalog;

		for (const name of ["init", "pre-turn", "pre-llm", "post-llm", "pre-tool", "post-tool", "compact", "workflow"]) {
			const entry = catalog.entries.find((item) => item.id === `general-harness:hook:${name}`);
			expect(entry?.migration).toMatchObject({
				state: "integrated",
				component: { kind: "hook", name, path: "hooks/hooks.toml" },
			});
		}
	});
});
