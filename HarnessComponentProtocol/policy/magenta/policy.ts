import type { ApprovalDecision, ShellPolicyClassification } from "../HcpServer.ts";
import { ApprovalPolicyProvider, decideApproval } from "./approval.ts";
import { classifyShellCommand, ShellPolicyProvider } from "./shell-policy.ts";

export class PolicyProvider {
	readonly approval: ApprovalPolicyProvider;
	readonly shell: ShellPolicyProvider;

	constructor(options?: { approval?: ApprovalPolicyProvider; shell?: ShellPolicyProvider }) {
		this.approval = options?.approval ?? new ApprovalPolicyProvider();
		this.shell = options?.shell ?? new ShellPolicyProvider();
	}

	decideApproval(input: unknown): ApprovalDecision {
		return decideApproval(input);
	}

	classifyShellCommand(input: unknown): ShellPolicyClassification {
		return classifyShellCommand(input);
	}
}
