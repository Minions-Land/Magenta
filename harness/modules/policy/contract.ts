export const APPROVAL_POLICY_TARGET = "approval://policy";
export const SHELL_POLICY_TARGET = "shell://policy";

export type ApprovalTier = "read" | "write" | "exec";
export type ApprovalMode = "always-ask" | "write" | "yolo";
export type ApprovalDecisionKind = "allow" | "deny" | "prompt";

export interface ApprovalStatus {
	target: typeof APPROVAL_POLICY_TARGET;
	mode_default: ApprovalMode;
	contract: {
		audience: "operator";
		model_surface: false;
		prompting: string;
	};
	modes: Record<
		ApprovalMode,
		{
			auto_approves: ApprovalTier[];
			prompts: ApprovalTier[];
		}
	>;
}

export interface ApprovalDecision {
	target: typeof APPROVAL_POLICY_TARGET;
	tool: string;
	tier: ApprovalTier;
	mode: ApprovalMode;
	decision: ApprovalDecisionKind;
	allowed: boolean;
	requires_prompt: boolean;
	denied: boolean;
	reason?: string;
	override: boolean;
	source: "user-policy" | "mode-yolo" | "safety-override" | "mode-tier";
}

/**
 * Approval policy provider contract. Business logic only - HcpServer conversion
 * is handled by the unified capability-server adapter.
 */
export interface ApprovalPolicyProviderContract {
	decide(input: unknown): ApprovalDecision;
	status(): ApprovalStatus;
}

export type ShellPolicyDecision = "allow" | "prompt" | "block";

export interface ShellPolicyFinding {
	code: string;
	severity: string;
	message: string;
	suggested_tool: string | null;
}

export interface ShellPolicyStatus {
	target: typeof SHELL_POLICY_TARGET;
	rules: string[];
	contract: {
		audience: "operator";
		execution: string;
		model_surface: false;
	};
}

export interface ShellPolicyClassification {
	target: typeof SHELL_POLICY_TARGET;
	command: string;
	decision: ShellPolicyDecision;
	mutating: boolean;
	findings: ShellPolicyFinding[];
	suggested_tools: string[];
	contract: {
		enforcement: "advisory-classification";
		model_surface: false;
	};
}

/**
 * Shell policy provider contract. Business logic only - HcpServer conversion
 * is handled by the unified capability-server adapter.
 */
export interface ShellPolicyProviderContract {
	classify(input: unknown): ShellPolicyClassification;
	status(): ShellPolicyStatus;
}

/**
 * Source-neutral policy capability surface. The policy capability is not a
 * model tool; it is a selected provider bundle that runtime/hook code can call
 * directly after resolving `policy` through HCP.
 *
 * Note: This bundle contains two sub-providers (approval and shell).
 * HcpServer conversion is handled by the unified capability-server adapter.
 */
export interface PolicyProviderContract {
	approval: ApprovalPolicyProviderContract;
	shell: ShellPolicyProviderContract;
	decideApproval(input: unknown): ApprovalDecision;
	classifyShellCommand(input: unknown): ShellPolicyClassification;
}
