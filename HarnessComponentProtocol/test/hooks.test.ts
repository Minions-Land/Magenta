import { describe, expect, it } from "vitest";
import { HcpClient } from "../HcpClient.ts";
import * as hooksServer from "../hooks/HcpServer.ts";
import * as hooksMagenta from "../hooks/magenta/HcpMagnet.ts";
import { HookProvider } from "../hooks/magenta/hooks.ts";

describe("hook provider", () => {
	it("discovers and describes migrated lifecycle hooks", async () => {
		const provider = new HookProvider();

		expect(provider.discover()).toMatchObject({
			provider: "hooks",
			targets: [
				"hook://init",
				"hook://pre-turn",
				"hook://pre-llm",
				"hook://post-llm",
				"hook://pre-tool",
				"hook://post-tool",
				"hook://compact",
				"hook://workflow",
			],
			lifecycle_targets: expect.arrayContaining(["hook://init", "hook://pre-tool", "hook://workflow"]),
		});
		expect(provider.describeHook("pre-tool")).toMatchObject({
			name: "pre-tool",
			target: "hook://pre-tool",
		});
		expect(() => provider.describeHook("sandbox-select")).toThrow("hook not found: sandbox-select");
	});

	it("runs pre-tool hook as declarative sandbox/approval/shell-policy actions", async () => {
		const magnet = new hooksMagenta.HcpMagnet({
			repoRoot: process.cwd(),
			kind: "hook",
			name: "hook",
			descriptorPath: "",
			source: "magenta",
		});
		const hcp = new HcpClient();
		hcp.registerModule(new hooksServer.HcpServer(), new Map([["hook", magnet]]));
		expect(hcp.addresses()).not.toContain("hook://sandbox-select");

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
				{
					type: "hcp_call",
					target: "hook://sandbox-select",
					op: "select",
					input: {
						tool: { name: "bash", operation: "write", tags: ["shell", "workspace-write"] },
						input: { command: "rm -rf tmp" },
					},
					purpose: "sandbox_selection",
				},
				{
					type: "hcp_call",
					target: "approval://policy",
					op: "decide",
					input: {
						tool: { name: "bash", operation: "write", tags: ["shell", "workspace-write"] },
						input: { command: "rm -rf tmp" },
					},
					purpose: "tool_approval",
				},
				{
					type: "hcp_call",
					target: "shell://policy",
					op: "classify",
					input: {
						tool: { name: "bash", operation: "write", tags: ["shell", "workspace-write"] },
						input: { command: "rm -rf tmp" },
					},
					purpose: "shell_policy",
				},
			],
			data: {
				sandbox: { target: "hook://sandbox-select", op: "select" },
				approval: { target: "approval://policy", op: "decide" },
				shell_policy: { target: "shell://policy", op: "classify" },
			},
		});
	});

	it("runs init and workflow hooks as action envelopes", async () => {
		const magnet = new hooksMagenta.HcpMagnet({
			repoRoot: process.cwd(),
			kind: "hook",
			name: "hook",
			descriptorPath: "",
			source: "magenta",
		});
		const hcp = new HcpClient();
		hcp.registerModule(new hooksServer.HcpServer(), new Map([["hook", magnet]]));

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
