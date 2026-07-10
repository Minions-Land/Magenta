import type { HcpClient, SshTarget, SshToolOperations, TodoState } from "@magenta/harness";
import { createSshToolOperations, HcpClientassemble } from "@magenta/harness";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { createLocalBashOperations } from "./tools/bash.ts";
import { createLocalReadOperations } from "./tools/read.ts";

const HCP_CLIENT_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "show", "todo"] as const;
const HCP_CLIENT_TOOL_MODULES = HCP_CLIENT_TOOL_NAMES.map((name) => `tools/${name}`);

export type HcpClienttoolassemblyoptions = {
	hcp: HcpClient;
	cwd: string;
	settingsManager: SettingsManager;
	sshTarget?: SshTarget;
	sshOperations?: SshToolOperations;
	sessionManager?: Pick<SessionManager, "getBranch">;
};

/** Assemble the host-selected core tools into the existing session Client. */
export async function HcpClientassembletools(options: HcpClienttoolassemblyoptions): Promise<void> {
	const todoSessionManager = options.sessionManager;
	const sshOperations =
		options.sshOperations ??
		(options.sshTarget ? createSshToolOperations(options.sshTarget, options.cwd) : undefined);
	const shellPath = options.settingsManager.getShellPath();
	const assembled = await HcpClientassemble({
		hcp: options.hcp,
		repoRoot: options.cwd,
		cwd: options.cwd,
		includeAutoload: false,
		modules: HCP_CLIENT_TOOL_MODULES,
		settings: {
			"tools/read": {
				autoResizeImages: options.settingsManager.getImageAutoResize(),
				operations: sshOperations?.read ?? createLocalReadOperations(),
			},
			"tools/bash": {
				operations: sshOperations?.bash ?? createLocalBashOperations({ shellPath }),
				commandPrefix: options.settingsManager.getShellCommandPrefix(),
			},
			...(sshOperations
				? {
						"tools/edit": { operations: sshOperations.edit },
						"tools/write": { operations: sshOperations.write },
					}
				: {}),
			...(todoSessionManager
				? {
						"tools/todo": {
							loadState: () => HcpClientloadtodostate(todoSessionManager),
						},
					}
				: {}),
		},
	});

	const errors = assembled.diagnostics.filter((diagnostic) => diagnostic.type === "error");
	const missing = HCP_CLIENT_TOOL_NAMES.filter((name) => options.hcp.resolveInstance(`tool:${name}`) === undefined);
	if (errors.length === 0 && missing.length === 0) return;

	const reasons = [
		...errors.map((diagnostic) => diagnostic.message),
		...(missing.length > 0 ? [`missing tool addresses: ${missing.join(", ")}`] : []),
	];
	throw new Error(`HcpClient core tool assembly failed: ${reasons.join("; ")}`);
}

function HcpClientloadtodostate(sessionManager: Pick<SessionManager, "getBranch">): TodoState | undefined {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		if (!HcpClientistodostate(message.details)) continue;
		return {
			todos: message.details.todos.map((todo) => ({ ...todo })),
			nextId: message.details.nextId,
		};
	}
	return undefined;
}

function HcpClientistodostate(value: unknown): value is TodoState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<TodoState>;
	return (
		Number.isInteger(state.nextId) &&
		state.nextId! >= 1 &&
		Array.isArray(state.todos) &&
		state.todos.every(
			(todo) =>
				todo !== null &&
				typeof todo === "object" &&
				Number.isInteger(todo.id) &&
				typeof todo.text === "string" &&
				typeof todo.done === "boolean",
		)
	);
}
