/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `magenta -p "prompt"` - text output
 * - `magenta --mode json "prompt"` - JSON event stream
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { formatNoApiKeyFoundMessage } from "../core/auth-guidance.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import {
	type BackgroundPolicy,
	createHeadlessRuntimeManifest,
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessRunEndEvent,
	type HeadlessRunStatus,
	type HeadlessUiEvent,
	type NonInteractiveUiPolicy,
} from "./headless-protocol.ts";
import { createNonInteractiveUiContext } from "./non-interactive-ui.ts";

const DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS = 60_000;

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** How to handle background work left running after the main agent becomes idle. */
	backgroundPolicy?: BackgroundPolicy;
	/** Total wait deadline used by backgroundPolicy="wait". */
	backgroundWaitTimeoutMs?: number;
	/** How blocking extension UI requests behave without an interactive client. */
	nonInteractiveUiPolicy?: NonInteractiveUiPolicy;
	/** Bind and validate model/auth/resources without sending a prompt. */
	validateOnly?: boolean;
	/** Runtime bootstrap failure to report through the normal terminal contract. */
	startupError?: string;
}

function lastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string } | undefined;
		if (message?.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

function remainingMs(deadline: number): number {
	return Math.max(0, deadline - Date.now());
}

async function waitForAgentIdleWithDeadline(waitForIdle: () => Promise<void>, deadline: number): Promise<boolean> {
	const timeoutMs = remainingMs(deadline);
	if (timeoutMs === 0) return false;
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			waitForIdle().then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const {
		mode,
		messages = [],
		initialMessage,
		initialImages,
		backgroundPolicy = "cancel",
		backgroundWaitTimeoutMs = DEFAULT_BACKGROUND_WAIT_TIMEOUT_MS,
		nonInteractiveUiPolicy = "deny",
		validateOnly = false,
		startupError,
	} = options;
	const runId = randomUUID();
	const startedAtMs = Date.now();
	let exitCode = 0;
	let status: HeadlessRunStatus = "success";
	let stopReason: string | undefined;
	let runError: string | undefined;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	let finalized = false;
	let signalReceived = false;
	let manifestSequence = 0;
	let bindingBuffer: object[] | undefined;
	let backgroundSettled = true;
	const uiEvents: HeadlessUiEvent[] = [];
	let uiErrorMessage: string | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const outputJson = (event: object): void => {
		if (mode !== "json") return;
		if (bindingBuffer) {
			bindingBuffer.push(event);
			return;
		}
		writeRawStdout(`${JSON.stringify(event)}\n`);
	};

	const onHeadlessUiEvent = (event: HeadlessUiEvent): void => {
		uiEvents.push(event);
		// A deny/error policy decision is authoritative even if the extension runner
		// later swallows the thrown NonInteractiveUiError as an extension_error.
		if (event.disposition === "error" && uiErrorMessage === undefined) {
			uiErrorMessage = event.message;
		}
		if (mode === "json") {
			outputJson(event);
		} else if (event.disposition !== "ignored") {
			console.error(event.message);
		}
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		await runtimeHost.dispose();
		unsubscribe?.();
		unsubscribe = undefined;
	};

	const finalize = async (): Promise<void> => {
		if (finalized) return;
		finalized = true;
		for (const cleanup of signalCleanupHandlers) cleanup();
		await disposeRuntime();

		if (mode === "json") {
			const endedAtMs = Date.now();
			const runEnd: HeadlessRunEndEvent = {
				type: "run_end",
				protocolVersion: HEADLESS_PROTOCOL_VERSION,
				runId,
				status,
				exitCode,
				startedAt: new Date(startedAtMs).toISOString(),
				endedAt: new Date(endedAtMs).toISOString(),
				durationMs: endedAtMs - startedAtMs,
				stopReason,
				error: runError,
				stats: session.getSessionStats(),
				background: {
					policy: backgroundPolicy,
					settled: backgroundSettled,
					events: session.getBackgroundEvents(),
				},
				nonInteractiveUi: {
					policy: nonInteractiveUiPolicy,
					requestCount: uiEvents.length,
				},
			};
			writeRawStdout(`${JSON.stringify(runEnd)}\n`);
		}
		await flushRawStdout();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");

		for (const signal of signals) {
			const handler = () => {
				const signalExitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
				signalReceived = true;
				status = "aborted";
				exitCode = signalExitCode;
				stopReason = "aborted";
				runError = `Interrupted by ${signal}`;
				backgroundSettled = false;
				killTrackedDetachedChildren();
				void session.abort().finally(() => finalize().finally(() => process.exit(signalExitCode)));
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		unsubscribe?.();
		const buffered: object[] = [];
		bindingBuffer = buffered;
		unsubscribe = session.subscribe((event) => outputJson(event));

		let bound = false;
		try {
			await session.bindExtensions({
				uiContext: createNonInteractiveUiContext({
					mode: mode === "json" ? "json" : "print",
					policy: nonInteractiveUiPolicy,
					onEvent: onHeadlessUiEvent,
				}),
				hasUI: false,
				mode: mode === "json" ? "json" : "print",
				commandContextActions: {
					newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
					fork: async (entryId, forkOptions) => {
						const result = await runtimeHost.fork(entryId, forkOptions);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, navigateOptions) => {
						const result = await session.navigateTree(targetId, {
							summarize: navigateOptions?.summarize,
							customInstructions: navigateOptions?.customInstructions,
							replaceInstructions: navigateOptions?.replaceInstructions,
							label: navigateOptions?.label,
						});
						return { cancelled: result.cancelled };
					},
					switchSession: async (sessionPath, switchOptions) =>
						runtimeHost.switchSession(sessionPath, switchOptions),
					reload: async () => {
						await session.reload();
					},
				},
				onError: (err) => {
					const event = {
						type: "extension_error",
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
					};
					outputJson(event);
					if (mode === "text") console.error(`Extension error (${err.extensionPath}): ${err.error}`);
				},
			});
			bound = true;
		} finally {
			bindingBuffer = undefined;
			if (mode === "json") {
				if (bound) {
					manifestSequence += 1;
					writeRawStdout(
						`${JSON.stringify(
							createHeadlessRuntimeManifest(runtimeHost, {
								mode: "json",
								runId,
								sequence: manifestSequence,
								oneShot: {
									backgroundPolicy,
									backgroundWaitTimeoutMs,
									nonInteractiveUiPolicy,
									validateOnly,
								},
							}),
						)}\n`,
					);
				}
				for (const event of buffered) writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		}
	};

	const settleBackgroundWork = async (): Promise<void> => {
		const running = () =>
			session.getBackgroundEvents().filter((event) => event.status === "running" || event.status === "terminating");
		const deadline = Date.now() + Math.max(0, backgroundWaitTimeoutMs);
		const failTimeout = (message: string): false => {
			backgroundSettled = false;
			status = "error";
			exitCode = 1;
			runError = message;
			return false;
		};
		const settleExternalActivations = async (): Promise<boolean> => {
			const quiet = await session.waitForExternalActivationQuiescence({ timeoutMs: remainingMs(deadline) });
			if (!quiet) {
				return failTimeout(`Timed out after ${backgroundWaitTimeoutMs}ms settling external activations`);
			}
			if (
				session.isStreaming &&
				!(await waitForAgentIdleWithDeadline(() => session.agent.waitForIdle(), deadline))
			) {
				return failTimeout(`Timed out after ${backgroundWaitTimeoutMs}ms waiting for a background continuation`);
			}
			return true;
		};

		// A completed event may still be inside the coordinator's debounce even when
		// no source reports running work. Commit that return before deciding the
		// one-shot run is settled.
		if (!(await settleExternalActivations())) return;
		if (running().length === 0) return;

		if (backgroundPolicy === "cancel") {
			backgroundSettled = false;
			return;
		}
		if (backgroundPolicy === "error") {
			backgroundSettled = false;
			status = "error";
			exitCode = 1;
			runError = `${running().length} background event(s) still running when the main agent became idle`;
			return;
		}

		while (running().length > 0) {
			const idle = await session.waitForBackgroundIdle({ timeoutMs: remainingMs(deadline) });
			if (!idle) {
				failTimeout(`Timed out after ${backgroundWaitTimeoutMs}ms waiting for background work`);
				return;
			}
			if (!(await settleExternalActivations())) return;
		}
	};

	registerSignalHandlers();
	runtimeHost.setRebindSession(async () => rebindSession());

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) writeRawStdout(`${JSON.stringify(header)}\n`);
		}

		await rebindSession();

		if (startupError) throw new Error(startupError);
		if (validateOnly) {
			const model = session.model;
			if (!model) throw new Error("No model selected");
			if (!session.modelRegistry.hasConfiguredAuth(model)) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
		} else {
			if (initialMessage) {
				await session.prompt(initialMessage, {
					images: initialImages,
					source: mode === "json" ? "json" : "print",
				});
			}

			for (const message of messages) {
				await session.prompt(message, { source: mode === "json" ? "json" : "print" });
			}
		}

		await settleBackgroundWork();

		const assistantMessage = validateOnly ? undefined : lastAssistantMessage(session.state.messages);
		if (assistantMessage) {
			stopReason = assistantMessage.stopReason;
			if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
				status = assistantMessage.stopReason === "aborted" ? "aborted" : "error";
				exitCode = 1;
				runError = assistantMessage.errorMessage || `Request ${assistantMessage.stopReason}`;
			}
		}

		// Under --non-interactive-ui error, a blocking UI request is a hard failure even if
		// the extension runner caught the thrown NonInteractiveUiError as an extension_error.
		if (status === "success" && uiErrorMessage !== undefined) {
			status = "error";
			exitCode = 1;
			runError = uiErrorMessage;
		}

		if (mode === "text") {
			if (status !== "success") {
				if (runError) console.error(runError);
			} else if (validateOnly) {
				writeRawStdout(
					`Headless configuration valid: ${session.model?.provider}/${session.model?.id}, ${session.getActiveToolNames().length} active tools\n`,
				);
			} else if (assistantMessage) {
				for (const content of assistantMessage.content) {
					if (content.type === "text") writeRawStdout(`${content.text}\n`);
				}
			}
		}
	} catch (error: unknown) {
		if (!signalReceived) {
			status = "error";
			exitCode = 1;
			runError = error instanceof Error ? error.message : String(error);
			if (!startupError) console.error(runError);
		}
	} finally {
		await finalize();
	}

	return exitCode;
}
