import {
	APPROVAL_POLICY_TARGET,
	type ApprovalDecision,
	type PolicyProviderContract,
	SHELL_POLICY_TARGET,
	type ShellPolicyClassification,
} from "../HcpServer.ts";
import { ApprovalPolicyProvider, decideApproval } from "./approval.ts";
import { classifyShellCommand, ShellPolicyProvider } from "./shell-policy.ts";

export class PolicyProvider implements PolicyProviderContract {
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
