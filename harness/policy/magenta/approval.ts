import type { HcpCall, HcpTarget, HcpTargetDescription } from "../../assembly/hcp/hcp.ts";
import {
	APPROVAL_POLICY_TARGET,
	type ApprovalDecision,
	type ApprovalDecisionKind,
	type ApprovalMode,
	type ApprovalPolicyProviderContract,
	type ApprovalStatus,
	type ApprovalTier,
} from "../contract.ts";

type UserDecision = ApprovalDecisionKind;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseTier(value: string): ApprovalTier {
	switch (value.trim().toLowerCase()) {
		case "read":
		case "readonly":
		case "read-only":
			return "read";
		case "write":
		case "edit":
		case "mutate":
			return "write";
		default:
			return "exec";
	}
}

function parseMode(value: string): ApprovalMode {
	switch (value.trim().toLowerCase()) {
		case "always-ask":
		case "always_ask":
		case "ask":
		case "prompt":
			return "always-ask";
		case "write":
		case "on-exec":
		case "exec":
			return "write";
		default:
			return "yolo";
	}
}

function parseUserDecision(value: string): UserDecision | undefined {
	switch (value.trim().toLowerCase()) {
		case "allow":
		case "allowed":
		case "yes":
		case "auto":
			return "allow";
		case "deny":
		case "denied":
		case "no":
		case "block":
		case "blocked":
			return "deny";
		case "prompt":
		case "ask":
		case "confirm":
			return "prompt";
		default:
			return undefined;
	}
}

function toolRecord(input: Record<string, unknown>): Record<string, unknown> {
	return isRecord(input.tool) ? input.tool : input;
}

function declaredTier(tool: Record<string, unknown>, input: Record<string, unknown>): ApprovalTier {
	const explicit = asString(input.tier) ?? asString(input.approval) ?? asString(tool.approval);
	if (explicit) return parseTier(explicit);
	const readOnly = asBoolean(tool.read_only) ?? false;
	const destructive = asBoolean(tool.destructive) ?? false;
	const tags = asStringArray(tool.tags);
	if (destructive || tags.some((tag) => ["execute", "runtime", "shell"].includes(tag))) {
		return "exec";
	}
	if (readOnly) {
		return "read";
	}
	if (tags.some((tag) => ["workspace-write", "edit", "session", "compact"].includes(tag))) {
		return "write";
	}
	return "exec";
}

function modeAutoApproves(mode: ApprovalMode, tier: ApprovalTier): boolean {
	if (mode === "always-ask") return tier === "read";
	if (mode === "write") return tier === "read" || tier === "write";
	return true;
}

function userPolicy(input: Record<string, unknown>, toolName: string): UserDecision | undefined {
	const policies = input.policies ?? input.policy ?? input.approval;
	if (typeof policies === "string") return parseUserDecision(policies);
	if (!isRecord(policies)) return undefined;
	return (
		parseUserDecision(asString(policies[toolName]) ?? "") ??
		parseUserDecision(asString(policies[toolName.toLowerCase()]) ?? "") ??
		parseUserDecision(asString(policies["*"]) ?? "")
	);
}

export function approvalStatus(): ApprovalStatus {
	return {
		target: APPROVAL_POLICY_TARGET,
		mode_default: "yolo",
		contract: {
			audience: "operator",
			model_surface: false,
			prompting: "prompt decisions are returned to the harness surface; this provider never blocks for UI input",
		},
		modes: {
			"always-ask": {
				auto_approves: ["read"],
				prompts: ["write", "exec"],
			},
			write: {
				auto_approves: ["read", "write"],
				prompts: ["exec"],
			},
			yolo: {
				auto_approves: ["read", "write", "exec"],
				prompts: [],
			},
		},
	};
}

export function decideApproval(rawInput: unknown): ApprovalDecision {
	const input = isRecord(rawInput) ? rawInput : {};
	const tool = toolRecord(input);
	const name = asString(tool.name) ?? asString(input.tool_name) ?? "unknown";
	const tier = declaredTier(tool, input);
	const mode = parseMode(asString(input.mode) ?? asString(input.approval_mode) ?? "yolo");
	const safety = isRecord(input.safety) ? input.safety : isRecord(tool.safety) ? tool.safety : undefined;
	const overridePrompt = asBoolean(input.override) ?? asBoolean(safety?.override) ?? false;
	const reason = asString(input.reason) ?? asString(safety?.reason);
	const policyDecision = userPolicy(input, name);

	const decision: UserDecision =
		mode === "yolo"
			? (policyDecision ?? "allow")
			: overridePrompt
				? policyDecision === "deny"
					? "deny"
					: "prompt"
				: (policyDecision ?? (modeAutoApproves(mode, tier) ? "allow" : "prompt"));

	return {
		target: APPROVAL_POLICY_TARGET,
		tool: name,
		tier,
		mode,
		decision,
		allowed: decision === "allow",
		requires_prompt: decision === "prompt",
		denied: decision === "deny",
		reason,
		override: overridePrompt,
		source: policyDecision
			? "user-policy"
			: mode === "yolo"
				? "mode-yolo"
				: overridePrompt
					? "safety-override"
					: "mode-tier",
	};
}

export class ApprovalPolicyProvider implements ApprovalPolicyProviderContract {
	decide(input: unknown): ApprovalDecision {
		return decideApproval(input);
	}

	status(): ApprovalStatus {
		return approvalStatus();
	}

	describe(): HcpTargetDescription {
		return {
			target: APPROVAL_POLICY_TARGET,
			kind: "approval",
			ops: ["discover", "describe", "decide", "call", "status"],
			description: "Resolve tool approval decisions from tool tier, session mode, user policy, and safety override.",
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
			},
		};
	}

	discover(): Record<string, unknown> {
		return {
			provider: "approval-policy",
			targets: [APPROVAL_POLICY_TARGET],
			operations: ["decide", "status"],
		};
	}

	toHcpTarget(): HcpTarget {
		return {
			describe: () => this.describe(),
			call: (call: HcpCall): unknown => {
				switch (call.op || "decide") {
					case "discover":
					case "list":
						return this.discover();
					case "describe":
						return {
							name: "approval-policy",
							target: APPROVAL_POLICY_TARGET,
							description: this.describe().description,
							operations: ["decide", "status"],
							default_mode: "yolo",
							tiers: ["read", "write", "exec"],
							decisions: ["allow", "prompt", "deny"],
						};
					case "decide":
					case "call":
						return this.decide(call.input);
					case "status":
						return this.status();
					default:
						throw new Error(`unsupported approval operation ${call.op}`);
				}
			},
		};
	}
}
