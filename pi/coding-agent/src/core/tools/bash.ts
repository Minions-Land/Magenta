import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	BASH_TOOL_DESCRIPTION,
	type BashToolDetails,
	type BashToolInput,
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
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { AdoptedExecutionHandle, BackgroundShellController } from "./bg-shell.ts";
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

/** Default inline deadline before a foreground bash call is promoted to background. */
export const DEFAULT_BASH_PROMOTE_AFTER_MS = 3000;

export type AutoPromotingBashOptions = BashToolOptions & {
	/** Controller used to adopt a still-running execution once the deadline passes. */
	backgroundShell: BackgroundShellController;
	/** Inline deadline in ms. Defaults to {@link DEFAULT_BASH_PROMOTE_AFTER_MS}. */
	promoteAfterMs?: number;
};

/**
 * Wrap the bash tool so a command that has not finished within a short inline
 * deadline is promoted into a background-shell event instead of blocking the
 * agent loop. The promoted event auto-returns its completed result to the main
 * agent, so long commands never stall the turn and their output is never lost.
 *
 * The underlying execution keeps running across promotion: the same child
 * process continues, its streamed output is forwarded into the adopted event's
 * tail, and the final result finalizes the event. Commands that finish within
 * the deadline behave exactly like the plain bash tool.
 */
export function createAutoPromotingBashToolDefinition(
	cwd: string,
	options: AutoPromotingBashOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return withBashAutoPromotion(createBashToolDefinition(cwd, options), cwd, {
		backgroundShell: options.backgroundShell,
		promoteAfterMs: options.promoteAfterMs,
	});
}

/**
 * Wrap an existing bash tool definition (e.g. one resolved through HCP with SSH
 * operations already bound) so it promotes to the background after the inline
 * deadline. The wrapped definition keeps the original renderer, schema, and
 * metadata; only its execute is augmented.
 */
export function withBashAutoPromotion<TState>(
	base: ToolDefinition<typeof bashSchema, BashToolDetails | undefined, TState>,
	cwd: string,
	options: { backgroundShell: BackgroundShellController; promoteAfterMs?: number },
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, TState> {
	const promoteAfterMs = options.promoteAfterMs ?? DEFAULT_BASH_PROMOTE_AFTER_MS;
	const { backgroundShell } = options;

	return {
		...base,
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const startedAt = Date.now();
			// Forward streamed output both to the live tool UI and, once promoted, into
			// the adopted event tail so the background view keeps updating.
			let handle: AdoptedExecutionHandle | undefined;
			let latestOutput = "";
			const wrappedUpdate: typeof onUpdate = (update) => {
				const text = extractResultText(update);
				if (text !== undefined) {
					if (handle && text.length >= latestOutput.length) handle.pushOutput(text.slice(latestOutput.length));
					latestOutput = text;
				}
				onUpdate?.(update as never);
			};

			const execPromise = Promise.resolve(
				base.execute(toolCallId, params, signal, wrappedUpdate as typeof onUpdate, ctx),
			);

			return promoteIfSlow({
				execPromise,
				promoteAfterMs,
				signal,
				onPromote: () => {
					handle = backgroundShell.adoptExecution(
						{
							command: params.command ?? "",
							cwd: resolveBashCwd(cwd, params, ctx),
							startedAt,
							tail: latestOutput,
							cancel: () => {
								// The child is owned by the underlying execute; cancellation flows
								// through the shared abort signal when the caller aborts the turn.
							},
						},
						ctx,
					);
					return handle.id;
				},
				onSettled: (result, error) => {
					if (!handle) return;
					if (error) {
						handle.finish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
						return;
					}
					const text = extractResultText(result);
					const isError = Boolean((result as { isError?: boolean })?.isError);
					handle.finish({
						status: isError ? "failed" : "exited",
						exitCode: isError ? 1 : 0,
						tail: text ?? latestOutput,
					});
				},
			});
		},
	};
}

function resolveBashCwd(cwd: string, params: BashToolInput, ctx?: ExtensionContext): string {
	const base = ctx?.cwd ?? cwd;
	const requested = (params as { cwd?: string }).cwd;
	if (!requested) return base;
	return requested;
}

/** Extract concatenated text from a tool update/result, tolerating string or block forms. */
function extractResultText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const content = (value as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Race an execution against an inline deadline. If the deadline fires first,
 * {@link onPromote} adopts the still-running execution and this resolves with a
 * short "promoted to background" result while the original promise continues in
 * the background and calls {@link onSettled} on completion.
 */
async function promoteIfSlow(config: {
	execPromise: Promise<unknown>;
	promoteAfterMs: number;
	signal: AbortSignal | undefined;
	onPromote: () => string;
	onSettled: (result: unknown, error: unknown) => void;
}): Promise<AgentToolResult<BashToolDetails | undefined>> {
	const { execPromise, promoteAfterMs, signal, onPromote, onSettled } = config;

	let timer: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<"promote">((resolve) => {
		timer = setTimeout(() => resolve("promote"), promoteAfterMs);
	});

	const raced = await Promise.race([
		execPromise.then(
			(result) => ({ kind: "done" as const, result }),
			(error) => ({ kind: "error" as const, error }),
		),
		timeoutPromise.then((kind) => ({ kind })),
	]);
	if (timer) clearTimeout(timer);

	if (raced.kind === "done") return raced.result as AgentToolResult<BashToolDetails | undefined>;
	if (raced.kind === "error") throw raced.error;

	// Deadline won: promote and let the execution finish in the background.
	if (signal?.aborted) {
		return (await execPromise) as AgentToolResult<BashToolDetails | undefined>;
	}
	const eventId = onPromote();
	void execPromise.then(
		(result) => onSettled(result, undefined),
		(error) => onSettled(undefined, error),
	);
	return {
		content: [
			{
				type: "text" as const,
				text: `Command still running after ${Math.round(promoteAfterMs / 1000)}s; promoted to background event ${eventId}. Its completed result will be returned automatically — continue with other work.`,
			},
		],
		details: { promotedTo: eventId } as unknown as BashToolDetails,
	};
}
