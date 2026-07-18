import type { HcpClient, SshTarget, SshToolOperations, TodoPlanState } from "@magenta/harness";
import {
	createSshToolOperations,
	HcpClientassemble,
	MAIN_TODO_SESSION_FILE_ENV,
	restoreTodoPlanState,
} from "@magenta/harness";
import { SessionManager } from "./session-manager.ts";
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
	/** Source-owned settings for stateful Tool modules, keyed by real module path. */
	statefulToolSettings?: Readonly<Record<string, unknown>>;
};

/** Assemble the host-selected core tools into the existing session Client. */
export async function HcpClientassembletools(options: HcpClienttoolassemblyoptions): Promise<void> {
	const todoSessionManager = options.sessionManager;
	const mainTodoSessionFile = process.env[MAIN_TODO_SESSION_FILE_ENV];
	const sshOperations =
		options.sshOperations ??
		(options.sshTarget ? createSshToolOperations(options.sshTarget, options.cwd) : undefined);
	const shellPath = options.settingsManager.getShellPath();
	const statefulSettings = options.statefulToolSettings ?? {};
	const statefulModules = ["tools/send-message", "tools/sub-agent", "tools/multiagent"];
	const disabledStatefulModules = statefulModules.filter((moduleName) => statefulSettings[moduleName] === undefined);
	const assembled = await HcpClientassemble({
		hcp: options.hcp,
		repoRoot: options.cwd,
		cwd: options.cwd,
		includeAutoload: false,
		includeSelectedProducts: ["tool"],
		skipOccupied: true,
		disabledModules: disabledStatefulModules,
		settings: {
			...statefulSettings,
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
			...(todoSessionManager || mainTodoSessionFile
				? {
						"tools/todo": {
							loadState: mainTodoSessionFile
								? () => loadTodoPlanStateFromSessionFile(mainTodoSessionFile)
								: () => loadTodoPlanStateFromBranch(todoSessionManager!),
							readOnly: Boolean(mainTodoSessionFile),
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

export function loadTodoPlanStateFromSessionFile(sessionFile: string): TodoPlanState | undefined {
	return loadTodoPlanStateFromBranch(SessionManager.open(sessionFile));
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
		const restored = restoreTodoPlanState(details?.state);
		if (!restored) continue;
		return restored;
	}
	return undefined;
}
