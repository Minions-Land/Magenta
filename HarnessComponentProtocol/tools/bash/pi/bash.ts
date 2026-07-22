import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	NODE_MAX_TIMEOUT_MS,
	NODE_MAX_TIMEOUT_SECONDS,
	validateNodeTimeoutSeconds,
} from "../../../_magenta/timeout.ts";
import { OutputAccumulator } from "../../../_magenta/utils/pi/output-accumulator.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "../../../_magenta/utils/pi/truncate.ts";

export const MAX_TIMEOUT_MS = NODE_MAX_TIMEOUT_MS;
export const MAX_TIMEOUT_SECONDS = NODE_MAX_TIMEOUT_SECONDS;

export const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (optional, no default timeout)",
			exclusiveMinimum: 0,
			maximum: MAX_TIMEOUT_SECONDS,
		}),
	),
});

function validateTimeout(timeout: number | undefined): number | undefined {
	return validateNodeTimeoutSeconds(timeout);
}

export type BashToolInput = Static<typeof bashSchema>;

export type BashToolDetails = {
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export type BashOperations = {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
};

export type BashSpawnContext = {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
};

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export type BashToolOptions = {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
};

/**
 * Inputs required to build the pure bash execute function.
 *
 * The shell-backed default operations and environment provider live in the
 * assembly layer (pi) because they depend on host shell discovery; harness only
 * holds the streaming/truncation algorithm and consumes injected dependencies.
 */
export type BashExecuteOptions = {
	/** Operations used to execute the command (required: no host default in harness). */
	operations: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands). */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution. */
	spawnHook?: BashSpawnHook;
	/** Provider for the base environment. Defaults to a copy of `process.env`. */
	resolveEnv?: () => NodeJS.ProcessEnv;
};

export const BASH_UPDATE_THROTTLE_MS = 100;

function resolveSpawnContext(
	command: string,
	cwd: string,
	resolveEnv: () => NodeJS.ProcessEnv,
	spawnHook?: BashSpawnHook,
): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...resolveEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

/**
 * Build the pure bash execute function.
 *
 * Contains the full streaming/truncation/timeout algorithm with no UI or
 * host-shell dependencies. Command execution is delegated to the injected
 * `operations`, and the base environment is supplied by `resolveEnv`.
 */
export function createBashExecute(cwd: string, options: BashExecuteOptions) {
	const ops = options.operations;
	const commandPrefix = options.commandPrefix;
	const spawnHook = options.spawnHook;
	const resolveEnv = options.resolveEnv ?? (() => ({ ...process.env }));

	return async function execute(
		_toolCallId: string,
		{ command, timeout }: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
	): Promise<AgentToolResult<BashToolDetails | undefined>> {
		const validatedTimeout = validateTimeout(timeout);
		const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
		const spawnContext = resolveSpawnContext(resolvedCommand, cwd, resolveEnv, spawnHook);
		const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
		let acceptingOutput = true;
		let updateTimer: NodeJS.Timeout | undefined;
		let updateDirty = false;
		let lastUpdateAt = 0;

		const emitOutputUpdate = () => {
			if (!onUpdate || !updateDirty) return;
			updateDirty = false;
			lastUpdateAt = Date.now();
			const snapshot = output.snapshot({ persistIfTruncated: true });
			onUpdate({
				content: [{ type: "text", text: snapshot.content || "" }],
				details: {
					truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
					fullOutputPath: snapshot.fullOutputPath,
				},
			});
		};

		const clearUpdateTimer = () => {
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = undefined;
			}
		};

		const scheduleOutputUpdate = () => {
			if (!onUpdate) return;
			updateDirty = true;
			const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
			if (delay <= 0) {
				clearUpdateTimer();
				emitOutputUpdate();
				return;
			}
			updateTimer ??= setTimeout(() => {
				updateTimer = undefined;
				emitOutputUpdate();
			}, delay);
		};

		if (onUpdate) {
			onUpdate({ content: [], details: undefined });
		}

		const handleData = (data: Buffer) => {
			if (!acceptingOutput) return;
			output.append(data);
			scheduleOutputUpdate();
		};

		const finishOutput = async () => {
			acceptingOutput = false;
			output.finish();
			clearUpdateTimer();
			emitOutputUpdate();
			const snapshot = output.snapshot({ persistIfTruncated: true });
			await output.closeTempFile();
			return snapshot;
		};

		const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
			const truncation = snapshot.truncation;
			let text = snapshot.content || emptyText;
			let details: BashToolDetails | undefined;
			if (truncation.truncated) {
				details = { truncation, fullOutputPath: snapshot.fullOutputPath };
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;
				if (truncation.lastLinePartial) {
					const lastLineSize = formatSize(output.getLastLineBytes());
					text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
				} else if (truncation.truncatedBy === "lines") {
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
				} else {
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
				}
			}
			return { text, details };
		};

		const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

		try {
			let exitCode: number | null;
			try {
				const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout: validatedTimeout,
					env: spawnContext.env,
				});
				exitCode = result.exitCode;
			} catch (err) {
				const snapshot = await finishOutput();
				const { text } = formatOutput(snapshot, "");
				if (err instanceof Error && err.message === "aborted") {
					throw new Error(appendStatus(text, "Command aborted"));
				}
				if (err instanceof Error && err.message.startsWith("timeout:")) {
					const timeoutSecs = err.message.split(":")[1];
					throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
				}
				throw err;
			}

			const snapshot = await finishOutput();
			const { text: outputText, details } = formatOutput(snapshot);
			if (exitCode !== 0 && exitCode !== null) {
				throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
			}
			return { content: [{ type: "text", text: outputText }], details };
		} finally {
			clearUpdateTimer();
		}
	};
}

/** Default tool description shared by the assembly layer. */
export const BASH_TOOL_DESCRIPTION = `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`;
