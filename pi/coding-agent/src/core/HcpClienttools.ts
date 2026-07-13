import type { HcpClient, SshTarget, SshToolOperations, TodoPlanState } from "@magenta/harness";
import { cloneTodoPlanState, createSshToolOperations, HcpClientassemble, isTodoPlanState } from "@magenta/harness";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { createLocalBashOperations } from "./tools/bash.ts";
import { createLocalReadOperations } from "./tools/read.ts";

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
		includeSelectedProducts: ["tool"],
		skipOccupied: true,
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
							loadState: () => loadTodoPlanStateFromBranch(todoSessionManager),
						},
					}
				: {}),
		},
	});

	const errors = assembled.diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) {
		throw new Error(`HcpClient tool assembly failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
	}
}

export function loadTodoPlanStateFromBranch(
	sessionManager: Pick<SessionManager, "getBranch">,
): TodoPlanState | undefined {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		const details = message.details as { state?: unknown } | undefined;
		if (!isTodoPlanState(details?.state)) continue;
		return cloneTodoPlanState(details.state);
	}
	return undefined;
}
