import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	BASH_TOOL_DESCRIPTION,
	type BashToolDetails,
	type BashToolOptions,
	bashSchema,
	createBashExecute,
	type BashOperations as HarnessBashOperations,
} from "@magenta/harness";
import { spawn } from "child_process";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import type { ToolRenderer } from "./renderer-registry.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

// Re-export the pure tool surface from harness so downstream pi consumers keep
// importing these names from the pi tools module unchanged.
export type {
	BashOperations,
	BashSpawnContext,
	BashSpawnHook,
	BashToolDetails,
	BashToolInput,
	BashToolOptions,
} from "@magenta/harness";

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): HarnessBashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

class BashResultRenderComponent extends Container {}

class BashCallRenderComponent implements Component {
	private text = new Text("", 0, 0);
	private args: { command?: string; timeout?: number } | undefined;
	private expanded = false;

	setArgs(args: { command?: string; timeout?: number } | undefined, expanded: boolean): void {
		this.args = args;
		this.expanded = expanded;
		this.text.setText(formatBashCall(args, expanded));
	}

	render(width: number): string[] {
		if (this.expanded) {
			return this.text.render(width);
		}
		return [truncateToWidth(formatBashCall(this.args, false), width, "...")];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function compactCommand(command: string): string {
	const normalized = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		return normalized.replace(/\s+/g, " ").trim();
	}
	const visibleLines = lines.slice(0, 2).join(" && ");
	return lines.length > 2 ? `${visibleLines} && ...` : visibleLines;
}

function countOutputLines(output: string): number {
	if (!output) return 0;
	return output.split("\n").length;
}

function formatHiddenOutputLine(outputLineCount: number): string {
	const label = outputLineCount === 1 ? "line" : "lines";
	return (
		theme.fg("muted", `... ${outputLineCount} output ${label} hidden (`) +
		keyHint("app.tools.expand", "to expand") +
		theme.fg("muted", ")")
	);
}

function formatCollapsedTruncationWarning(): string {
	return (
		theme.fg("warning", "[Output truncated; ") + keyHint("app.tools.expand", "for details") + theme.fg("warning", "]")
	);
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined, expanded: boolean): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay =
		command === null
			? invalidArgText(theme)
			: command
				? expanded
					? command
					: compactCommand(command)
				: theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		if (options.expanded) {
			const styledOutput = output
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild(new Text(`\n${formatHiddenOutputLine(countOutputLines(output))}`, 0, 0));
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		if (options.expanded) {
			const warnings: string[] = [];
			if (fullOutputPath) {
				warnings.push(`Full output: ${fullOutputPath}`);
			}
			if (truncation?.truncated) {
				if (truncation.truncatedBy === "lines") {
					warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
				} else {
					warnings.push(
						`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
					);
				}
			}
			component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
		} else {
			component.addChild(new Text(`\n${formatCollapsedTruncationWarning()}`, 0, 0));
		}
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

/**
 * Renderer for the "shell-output" data shape (bash tool output). Pulls state,
 * lastComponent, executionStarted, isError, showImages and invalidate from the
 * render context, so any tool producing {@link BashToolDetails}-shaped results
 * can reuse it. Registered in register-builtin-renderers.ts.
 */
export const bashRenderer: ToolRenderer<BashToolDetails | undefined> = {
	renderCall(args, _theme, context) {
		const state = context.state as BashRenderState;
		if (context.executionStarted && state.startedAt === undefined) {
			state.startedAt = Date.now();
			state.endedAt = undefined;
		}
		const component =
			context.lastComponent instanceof BashCallRenderComponent
				? context.lastComponent
				: new BashCallRenderComponent();
		component.setArgs(args, context.expanded);
		return component;
	},
	renderResult(result, options, _theme, context) {
		const state = context.state as BashRenderState;
		if (state.startedAt !== undefined && options.isPartial && !state.interval) {
			state.interval = setInterval(() => context.invalidate(), 1000);
		}
		if (!options.isPartial || context.isError) {
			state.endedAt ??= Date.now();
			if (state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}
		}
		const component =
			(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
		rebuildBashResultRenderComponent(
			component,
			result as any,
			options,
			context.showImages,
			state.startedAt,
			state.endedAt,
		);
		component.invalidate();
		return component;
	},
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const execute = createBashExecute(cwd, {
		operations: ops,
		commandPrefix: options?.commandPrefix,
		spawnHook: options?.spawnHook,
		resolveEnv: () => getShellEnv(),
	});
	return {
		name: "bash",
		label: "bash",
		description: BASH_TOOL_DESCRIPTION,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		renderKind: "shell-output",
		execute(_toolCallId, params, signal, onUpdate, _ctx) {
			return execute(_toolCallId, params, signal, onUpdate);
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
