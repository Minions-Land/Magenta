import {
	SHELL_POLICY_TARGET,
	type ShellPolicyClassification,
	type ShellPolicyFinding,
	type ShellPolicyProviderContract,
	type ShellPolicyStatus,
} from "../contract.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandFromInput(input: unknown): string {
	if (!isRecord(input)) return "";
	if (typeof input.command === "string") return input.command.trim();
	if (isRecord(input.input) && typeof input.input.command === "string") return input.input.command.trim();
	return "";
}

function finding(code: string, severity: string, message: string, suggestedTool?: string): ShellPolicyFinding {
	return {
		code,
		severity,
		message,
		suggested_tool: suggestedTool ?? null,
	};
}

function normalizeShellCommand(command: string): string {
	const trimmed = command.trimStart();
	return (trimmed.startsWith("command ") ? trimmed.slice("command ".length) : trimmed).trimStart().toLowerCase();
}

function commandStartsWithAny(command: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => command.startsWith(prefix));
}

function commandHasWriteRedirect(command: string): boolean {
	for (let index = 0; index < command.length; index++) {
		if (command[index] !== ">") continue;
		const previous = command[index - 1] ?? " ";
		const next = command[index + 1] ?? " ";
		if (previous !== "2" && next !== "&") return true;
	}
	return false;
}

function commandHasInplaceEdit(command: string): boolean {
	return (
		command.startsWith("sed -i") ||
		command.includes(" sed -i") ||
		command.startsWith("perl -i") ||
		command.includes(" perl -i") ||
		command.includes("awk -i inplace")
	);
}

export function shellPolicyStatus(): ShellPolicyStatus {
	return {
		target: SHELL_POLICY_TARGET,
		rules: [
			"file-read-shell-command",
			"text-search-shell-command",
			"file-discovery-shell-command",
			"shell-redirection-write",
			"shell-inplace-edit",
		],
		contract: {
			audience: "operator",
			execution: "read-only command classification; does not execute shell commands",
			model_surface: false,
		},
	};
}

export function classifyShellCommand(input: unknown): ShellPolicyClassification {
	const command = commandFromInput(input);
	const normalized = normalizeShellCommand(command);
	const findings: ShellPolicyFinding[] = [];
	const suggestedTools: string[] = [];
	let mutating = false;

	if (normalized === "") {
		findings.push(finding("empty-command", "block", "Shell command is empty."));
	}
	if (commandHasWriteRedirect(normalized)) {
		mutating = true;
		findings.push(
			finding("shell-redirect-write", "prompt", "Command appears to write through shell redirection.", "Write"),
		);
		suggestedTools.push("Write");
	}
	if (commandHasInplaceEdit(normalized)) {
		mutating = true;
		findings.push(finding("shell-inplace-edit", "prompt", "Command appears to edit files in place.", "EditHashline"));
		suggestedTools.push("EditHashline");
	}
	if (commandStartsWithAny(normalized, ["cat ", "head ", "tail ", "less ", "more "])) {
		findings.push(
			finding("shell-file-read", "suggest", "Prefer native file read tooling for plain file inspection.", "Read"),
		);
		suggestedTools.push("Read");
	}
	if (commandStartsWithAny(normalized, ["grep ", "rg ", "ag "])) {
		findings.push(
			finding("shell-text-search", "suggest", "Prefer native search tooling for text search.", "SearchToolBm25"),
		);
		suggestedTools.push("SearchToolBm25");
	}
	if (commandStartsWithAny(normalized, ["find ", "fd "])) {
		findings.push(
			finding(
				"shell-file-discovery",
				"suggest",
				"Prefer native glob/fuzzy-find tooling for file discovery.",
				"Glob",
			),
		);
		suggestedTools.push("Glob");
	}

	const uniqueSuggestedTools = [...new Set(suggestedTools)].sort();
	const decision = findings.some((item) => item.severity === "block") ? "block" : mutating ? "prompt" : "allow";

	return {
		target: SHELL_POLICY_TARGET,
		command,
		decision,
		mutating,
		findings,
		suggested_tools: uniqueSuggestedTools,
		contract: {
			enforcement: "advisory-classification",
			model_surface: false,
		},
	};
}

export class ShellPolicyProvider implements ShellPolicyProviderContract {
	classify(input: unknown): ShellPolicyClassification {
		return classifyShellCommand(input);
	}

	status(): ShellPolicyStatus {
		return shellPolicyStatus();
	}
}
