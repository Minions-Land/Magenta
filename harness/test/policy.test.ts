import { describe, expect, it } from "vitest";
import { HcpClient } from "../hcp-client/hcp-client.ts";
import { getHarnessRegistryPath, loadRegistry } from "../hcp-client/registry/registry.ts";
import { ApprovalPolicyProvider, decideApproval } from "../modules/policy/magenta/approval.ts";
import { classifyShellCommand, ShellPolicyProvider } from "../modules/policy/magenta/shell-policy.ts";

describe("policy providers", () => {
	it("decides approval from mode, tier, override, and user policy", () => {
		expect(decideApproval({ tool: { name: "Read", read_only: true }, mode: "always-ask" })).toMatchObject({
			target: "approval://policy",
			tool: "Read",
			tier: "read",
			mode: "always-ask",
			decision: "allow",
			allowed: true,
			source: "mode-tier",
		});
		expect(decideApproval({ tool: { name: "Bash", tags: ["shell"] }, mode: "write" })).toMatchObject({
			tier: "exec",
			decision: "prompt",
			requires_prompt: true,
		});
		expect(
			decideApproval({
				tool: { name: "Bash", tags: ["shell"] },
				mode: "yolo",
				policies: { bash: "deny" },
			}),
		).toMatchObject({
			decision: "deny",
			denied: true,
			source: "user-policy",
		});
	});

	it("classifies shell commands without executing them", () => {
		expect(classifyShellCommand({ command: "cat README.md" })).toMatchObject({
			target: "shell://policy",
			decision: "allow",
			mutating: false,
			suggested_tools: ["Read"],
		});
		expect(classifyShellCommand({ command: "sed -i 's/a/b/' file.txt" })).toMatchObject({
			decision: "prompt",
			mutating: true,
			suggested_tools: ["EditHashline"],
		});
		expect(classifyShellCommand({ command: "" })).toMatchObject({
			decision: "block",
			findings: [{ code: "empty-command", severity: "block", suggested_tool: null }],
		});
	});

	it("dispatches approval and shell policy through HCP", async () => {
		const hcp = new HcpClient()
			.registerServer("approval://policy", new ApprovalPolicyProvider().toHcpServer())
			.registerServer("shell://policy", new ShellPolicyProvider().toHcpServer());

		await expect(
			hcp.dispatch({
				target: "approval://policy",
				op: "decide",
				input: { tool: { name: "Edit", tags: ["workspace-write"] }, mode: "always-ask" },
			}),
		).resolves.toMatchObject({
			decision: "prompt",
			tier: "write",
		});
		await expect(
			hcp.dispatch({
				target: "shell://policy",
				op: "classify",
				input: { command: "echo hello > out.txt" },
			}),
		).resolves.toMatchObject({
			decision: "prompt",
			suggested_tools: ["Write"],
		});
	});
});
