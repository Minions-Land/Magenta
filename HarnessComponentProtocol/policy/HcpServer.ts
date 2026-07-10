import type { HcpMagnetBinding } from "../.HCP/HcpMagnetTypes.ts";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";

export class HcpServer {
	readonly moduleName = "policy";
	readonly description = "Approval and shell-command policy decisions.";

	private binding(magnet: { toCapability?(): unknown }): HcpMagnetBinding<PolicyProvider> {
		return magnet.toCapability?.() as HcpMagnetBinding<PolicyProvider>;
	}

	describeSource(
		_selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
	): HcpServerDescription {
		const binding = this.binding(magnet);
		return {
			target: "capability:policy",
			kind: "policy",
			ops: ["decideApproval", "classifyShellCommand", "call"],
			description: this.description,
			metadata: {
				name: binding.name,
				source: binding.source,
				implementation: "native-ts",
				hotSwappable: magnet.hotSwappable ?? false,
			},
		};
	}

	sourceAddresses(): string[] {
		return ["capability:policy", APPROVAL_POLICY_TARGET, SHELL_POLICY_TARGET];
	}

	callSource(_selector: string, magnet: { toCapability?(): unknown }, request: HcpServerRequest): unknown {
		const provider = this.binding(magnet).instance;
		if (request.target === APPROVAL_POLICY_TARGET) {
			return request.op === "status" ? provider.approval.status() : provider.approval.decide(request.input);
		}
		if (request.target === SHELL_POLICY_TARGET) {
			return request.op === "status" ? provider.shell.status() : provider.shell.classify(request.input);
		}
		switch (request.op || "call") {
			case "decideApproval":
			case "call":
				return provider.decideApproval(request.input);
			case "classifyShellCommand":
				return provider.classifyShellCommand(request.input);
			default:
				throw new Error(`Unknown operation: ${request.op} for policy capability`);
		}
	}
}

export const APPROVAL_POLICY_TARGET = "approval://policy";
export const SHELL_POLICY_TARGET = "shell://policy";

export type ApprovalTier = "read" | "write" | "exec";
export type ApprovalMode = "always-ask" | "write" | "yolo";
export type ApprovalDecisionKind = "allow" | "deny" | "prompt";

export type ApprovalStatus = {
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
};

export type ApprovalDecision = {
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
};

/**
 * Approval policy provider surface. Business logic only - HcpServer conversion
 * is handled by the unified capability-server adapter.
 */
export type ApprovalPolicyProvider = {
	decide(input: unknown): ApprovalDecision;
	status(): ApprovalStatus;
};

export type ShellPolicyDecision = "allow" | "prompt" | "block";

export type ShellPolicyFinding = {
	code: string;
	severity: string;
	message: string;
	suggested_tool: string | null;
};

export type ShellPolicyStatus = {
	target: typeof SHELL_POLICY_TARGET;
	rules: string[];
	contract: {
		audience: "operator";
		execution: string;
		model_surface: false;
	};
};

export type ShellPolicyClassification = {
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
};

/**
 * Shell policy provider surface. Business logic only - HcpServer conversion
 * is handled by the unified capability-server adapter.
 */
export type ShellPolicyProvider = {
	classify(input: unknown): ShellPolicyClassification;
	status(): ShellPolicyStatus;
};

/**
 * Source-neutral policy capability surface. The policy capability is not a
 * model tool; it is a selected provider bundle that runtime/hook code can call
 * directly after resolving `policy` through HCP.
 *
 * Note: This bundle contains two sub-providers (approval and shell).
 * HcpServer conversion is handled by the unified capability-server adapter.
 */
export type PolicyProvider = {
	approval: ApprovalPolicyProvider;
	shell: ShellPolicyProvider;
	decideApproval(input: unknown): ApprovalDecision;
	classifyShellCommand(input: unknown): ShellPolicyClassification;
};
