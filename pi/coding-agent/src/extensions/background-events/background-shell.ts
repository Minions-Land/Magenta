/**
 * Background shell tools.
 *
 * Starts long-running shell commands as session-scoped events, then lets the agent
 * poll, wait for completion, or cancel them without blocking a tool call forever.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendTail as appendTailText,
	formatDuration,
	RESULT_LIMIT_BYTES,
	shellQuote,
	timestampForFile,
	truncateTail,
} from "../shared/shell.ts";
import type { createEventsMonitor } from "./event-monitor.ts";

const LOG_DIR = join(homedir(), ".pi", "agent", "tmp", "background-shell");
const TERM_GRACE_MS = 3000;

type EventStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type BackgroundShellConfig = {
	defaultTimeoutSeconds?: number;
	defaultWaitTimeoutSeconds?: number;
	defaultReturnToMain: boolean;
	defaultReturnDelivery: ReturnDelivery;
};

const shellConfig: BackgroundShellConfig = {
	defaultReturnToMain: false,
	defaultReturnDelivery: "followUp",
};

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatConfig(config: BackgroundShellConfig): string {
	return [
		"Background shell configuration:",
		`defaultTimeoutSeconds: ${config.defaultTimeoutSeconds ?? "none"}`,
		`defaultWaitTimeoutSeconds: ${config.defaultWaitTimeoutSeconds ?? "none"}`,
		`defaultReturnToMain: ${config.defaultReturnToMain}`,
		`defaultReturnDelivery: ${config.defaultReturnDelivery}`,
	].join("\n");
}

type BackgroundEvent = {
	id: string;
	command: string;
	cwd: string;
	label?: string;
	logPath: string;
	child: ChildProcess;
	log: WriteStream;
	startedAt: number;
	endedAt?: number;
	status: EventStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
};

function appendTail(event: BackgroundEvent, data: Buffer): void {
	event.tail = appendTailText(event.tail, data);
}

function killProcessGroup(event: BackgroundEvent, signal: NodeJS.Signals): void {
	const pid = event.child.pid;
	if (!pid) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			event.child.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

function finishEvent(
	event: BackgroundEvent,
	status: EventStatus,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	error?: string,
): void {
	if (event.status !== "running") return;

	event.status = status;
	event.exitCode = exitCode;
	event.signal = signal;
	event.error = error;
	event.endedAt = Date.now();
	if (event.timeout) clearTimeout(event.timeout);
	if (!event.log.writableEnded && !event.log.destroyed) event.log.end();

	const waiters = event.waiters.splice(0);
	for (const resolveWaiter of waiters) resolveWaiter();
}

function summarizeEvent(event: BackgroundEvent, includeOutput = true): string {
	const elapsedUntil = event.endedAt ?? Date.now();
	const output = truncateTail(event.tail.trimEnd());
	const lines = [
		`Event: ${event.id}${event.label ? ` (${event.label})` : ""}`,
		`Status: ${event.status}`,
		`Command: ${event.command}`,
		`CWD: ${event.cwd}`,
		`Elapsed: ${formatDuration(elapsedUntil - event.startedAt)}`,
		`Exit code: ${event.exitCode ?? "n/a"}`,
		`Signal: ${event.signal ?? "n/a"}`,
		`Log: ${event.logPath}`,
	];
	if (event.error) lines.push(`Error: ${event.error}`);
	if (includeOutput) {
		lines.push(
			"",
			output.truncated ? `[Output truncated to last ${RESULT_LIMIT_BYTES} bytes]` : "Output:",
			output.text || "(no output yet)",
		);
	}
	return lines.join("\n");
}

function waitForEvent(
	event: BackgroundEvent,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
): Promise<"done" | "timeout" | "aborted"> {
	if (event.status !== "running") return Promise.resolve("done");
	if (signal?.aborted) return Promise.resolve("aborted");

	return new Promise((resolveWait) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let waiter: () => void;

		const done = (result: "done" | "timeout" | "aborted") => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const index = event.waiters.indexOf(waiter);
			if (index >= 0) event.waiters.splice(index, 1);
			resolveWait(result);
		};

		const onAbort = () => done("aborted");
		waiter = () => done("done");
		event.waiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });

		if (timeoutSeconds && timeoutSeconds > 0) {
			timer = setTimeout(() => done("timeout"), timeoutSeconds * 1000);
		}
	});
}

type EventsMonitor = ReturnType<typeof createEventsMonitor>;

export function installBackgroundShell(pi: ExtensionAPI, eventsMonitor: EventsMonitor) {
	let nextEventNumber = 1;
	let shuttingDown = false;
	const events = new Map<string, BackgroundEvent>();
	function cancelEvent(id: string, ctx?: ExtensionContext): boolean {
		const event = events.get(id);
		if (!event || event.status !== "running") return false;
		finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by background events UI");
		monitor.update(ctx);
		killProcessGroup(event, "SIGTERM");
		setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
		return true;
	}

	const monitor = eventsMonitor.registerSource({
		id: "shell",
		title: "shell",
		getEvents: () =>
			[...events.values()].map((event) => ({
				id: event.id,
				status: event.status,
				startedAt: event.startedAt,
				endedAt: event.endedAt,
				label: event.label ?? event.command,
				cwd: event.cwd,
				logPath: event.logPath,
				tail: event.tail,
				canCancel: event.status === "running",
			})),
		getEventDetails: (id) => {
			const event = events.get(id);
			if (!event) return [`unknown shell event: ${id}`];
			return [
				`command: ${event.command}`,
				`cwd: ${event.cwd}`,
				`log: ${event.logPath}`,
				`exit: ${event.exitCode ?? "n/a"}`,
				`signal: ${event.signal ?? "n/a"}`,
				...(event.error ? [`error: ${event.error}`] : []),
			];
		},
		cancelEvent,
	});

	function returnShellResultToMain(event: BackgroundEvent, delivery: ReturnDelivery, instruction?: string): void {
		if (shuttingDown) return;
		const defaultInstruction =
			"Background shell event has completed. Read this returned result, use it to continue the original task, and do not ask the user to manually inspect the event id unless more information is needed.";
		pi.sendMessage(
			{
				customType: "bg-shell-return",
				content: `${instruction?.trim() || defaultInstruction}\n\n${summarizeEvent(event)}`,
				display: true,
				details: { id: event.id, status: event.status, exitCode: event.exitCode, logPath: event.logPath },
			},
			{ deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
		);
	}

	function scheduleReturnToMain(event: BackgroundEvent, delivery: ReturnDelivery, instruction?: string): void {
		void waitForEvent(event, undefined, undefined)
			.then(() => returnShellResultToMain(event, delivery, instruction))
			.catch(() => undefined);
	}

	pi.registerTool({
		name: "bg_shell",
		label: "Background Shell",
		description:
			"Manage non-interactive shell commands as background events. Use action=start for long-running commands; set returnToMain=true to automatically send the completed result back to the main agent. Use action=status to inspect events, action=wait to wait, action=cancel to terminate a running event, and action=config to inspect or update session defaults.",
		promptSnippet: "Start, inspect, wait for, or cancel long-running shell commands as background events",
		promptGuidelines: [
			"Use bg_shell action=start for long-running commands such as builds, tests, dev servers, migrations, downloads, or commands expected to take more than about 10 seconds.",
			"Use the regular bash tool for short one-off shell commands.",
			"After bg_shell action=start, either call bg_shell action=status/action=wait before relying on the command result, or set returnToMain=true so the result is automatically returned as a follow-up to the main agent.",
			"Do not use bg_shell action=start for commands that require interactive stdin.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "status", "wait", "cancel", "config"] as const),
			command: Type.Optional(Type.String({ description: "Shell command to run for action=start." })),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for action=start. Relative paths are resolved against the current cwd.",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Number({
					description:
						"Optional maximum runtime for action=start. If exceeded, the event is terminated and marked timed_out.",
				}),
			),
			label: Type.Optional(Type.String({ description: "Optional human-readable label for action=start." })),
			returnToMain: Type.Optional(
				Type.Boolean({
					description:
						"For action=start, automatically send the completed event result back to the main agent and trigger continuation. Default: false.",
				}),
			),
			returnDelivery: Type.Optional(
				StringEnum(["steer", "followUp", "nextTurn"] as const, {
					description: "Delivery mode when returnToMain=true. Default: followUp.",
				}),
			),
			returnInstruction: Type.Optional(
				Type.String({
					description: "Optional instruction prepended to the automatic return message for the parent agent.",
				}),
			),
			eventId: Type.Optional(
				Type.String({
					description: "Event id for action=status/wait/cancel. Omit for action=status to list all events.",
				}),
			),
			waitTimeoutSeconds: Type.Optional(
				Type.Number({
					description:
						"Maximum time to wait for action=wait. If omitted, uses configured default or waits until completion/tool cancellation.",
				}),
			),
			defaultTimeoutSeconds: Type.Optional(
				Type.Number({
					description: "For action=config: set default maximum runtime for future start calls. Use <=0 to clear.",
				}),
			),
			defaultWaitTimeoutSeconds: Type.Optional(
				Type.Number({
					description: "For action=config: set default maximum wait time for future wait calls. Use <=0 to clear.",
				}),
			),
			defaultReturnToMain: Type.Optional(
				Type.Boolean({ description: "For action=config: default returnToMain for future start calls." }),
			),
			defaultReturnDelivery: Type.Optional(
				StringEnum(["steer", "followUp", "nextTurn"] as const, {
					description: "For action=config: default delivery mode when automatic return is enabled.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action;
			const returnToMain = params.returnToMain ?? shellConfig.defaultReturnToMain;
			const returnDelivery = (params.returnDelivery ?? shellConfig.defaultReturnDelivery) as ReturnDelivery;
			const returnInstruction = params.returnInstruction as string | undefined;

			if (action === "config") {
				if ("defaultTimeoutSeconds" in params)
					shellConfig.defaultTimeoutSeconds = positiveNumber(params.defaultTimeoutSeconds);
				if ("defaultWaitTimeoutSeconds" in params)
					shellConfig.defaultWaitTimeoutSeconds = positiveNumber(params.defaultWaitTimeoutSeconds);
				if (typeof params.defaultReturnToMain === "boolean")
					shellConfig.defaultReturnToMain = params.defaultReturnToMain;
				if (params.defaultReturnDelivery)
					shellConfig.defaultReturnDelivery = params.defaultReturnDelivery as ReturnDelivery;
				return { content: [{ type: "text", text: formatConfig(shellConfig) }], details: { ...shellConfig } };
			}

			if (action === "start") {
				if (!params.command) throw new Error("bg_shell action=start requires command");
				if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled before start" }], details: {} };

				await mkdir(LOG_DIR, { recursive: true });

				const id = `bg_${String(nextEventNumber++).padStart(3, "0")}`;
				const cwd = resolve(ctx.cwd, params.cwd ?? ".");
				const logPath = join(LOG_DIR, `${id}-${timestampForFile()}.log`);
				const log = createWriteStream(logPath, { flags: "a" });
				const shell = process.env.SHELL || "/bin/bash";
				const child = spawn(shell, ["-lc", params.command], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});

				const event: BackgroundEvent = {
					id,
					command: params.command,
					cwd,
					label: params.label,
					logPath,
					child,
					log,
					startedAt: Date.now(),
					status: "running",
					exitCode: null,
					signal: null,
					tail: "",
					waiters: [],
				};
				events.set(id, event);
				monitor.update(ctx);

				log.write(`$ cd ${shellQuote(cwd)} && ${params.command}\n\n`);
				child.stdout.on("data", (data: Buffer) => {
					if (!log.writableEnded && !log.destroyed) log.write(data);
					appendTail(event, data);
				});
				child.stderr.on("data", (data: Buffer) => {
					if (!log.writableEnded && !log.destroyed) log.write(data);
					appendTail(event, data);
				});
				child.on("error", (error) => {
					finishEvent(event, "failed", null, null, error.message);
					monitor.update(ctx);
				});
				child.on("close", (code, closeSignal) => {
					const timedOut = event.status === "timed_out";
					const cancelled = event.status === "cancelled";
					if (timedOut || cancelled) return;
					finishEvent(event, code === 0 ? "exited" : "failed", code, closeSignal);
					monitor.update(ctx);
					try {
						ctx.ui.notify(
							`Background event ${id} finished: ${event.status}${code === null ? "" : ` (${code})`}`,
							code === 0 ? "info" : "warning",
						);
					} catch {
						// UI may no longer be available.
					}
				});

				const timeoutSeconds = positiveNumber(params.timeoutSeconds) ?? shellConfig.defaultTimeoutSeconds;
				if (timeoutSeconds) {
					event.timeout = setTimeout(() => {
						finishEvent(event, "timed_out", null, "SIGTERM", `Timed out after ${timeoutSeconds}s`);
						monitor.update(ctx);
						killProcessGroup(event, "SIGTERM");
						setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
					}, timeoutSeconds * 1000);
				}

				if (returnToMain) scheduleReturnToMain(event, returnDelivery, returnInstruction);

				return {
					content: [
						{
							type: "text",
							text: `Started background event ${id}${returnToMain ? " with automatic return to main agent" : ""}\nCommand: ${params.command}\nCWD: ${cwd}\nLog: ${logPath}${timeoutSeconds ? `\nTimeout: ${timeoutSeconds}s` : ""}`,
						},
					],
					details: {
						id,
						command: params.command,
						cwd,
						logPath,
						status: "running",
						returnsToMain: returnToMain,
						timeoutSeconds,
					},
				};
			}

			if (action === "status") {
				if (!params.eventId) {
					const lines = [...events.values()].map((event) => {
						const elapsedUntil = event.endedAt ?? Date.now();
						return `${event.id}\t${event.status}\t${formatDuration(elapsedUntil - event.startedAt)}\t${event.label ?? event.command}`;
					});
					return {
						content: [{ type: "text", text: lines.length ? lines.join("\n") : "No background events." }],
						details: { events: lines.length },
					};
				}

				const event = events.get(params.eventId);
				if (!event) throw new Error(`Unknown background event: ${params.eventId}`);
				return {
					content: [{ type: "text", text: summarizeEvent(event) }],
					details: { id: event.id, status: event.status, exitCode: event.exitCode, logPath: event.logPath },
				};
			}

			if (action === "wait") {
				if (!params.eventId) throw new Error("bg_shell action=wait requires eventId");
				const event = events.get(params.eventId);
				if (!event) throw new Error(`Unknown background event: ${params.eventId}`);

				const waitTimeoutSeconds =
					positiveNumber(params.waitTimeoutSeconds) ?? shellConfig.defaultWaitTimeoutSeconds;
				const result = await waitForEvent(event, waitTimeoutSeconds, signal);
				if (result === "aborted")
					return {
						content: [
							{
								type: "text",
								text: `Wait cancelled. Event ${event.id} is still ${event.status}.\nLog: ${event.logPath}`,
							},
						],
						details: { id: event.id, status: event.status },
					};
				if (result === "timeout")
					return {
						content: [
							{
								type: "text",
								text: `Wait timed out. Event ${event.id} is still running.\n\n${summarizeEvent(event)}`,
							},
						],
						details: { id: event.id, status: event.status, logPath: event.logPath },
					};

				return {
					content: [{ type: "text", text: summarizeEvent(event) }],
					details: { id: event.id, status: event.status, exitCode: event.exitCode, logPath: event.logPath },
				};
			}

			if (action === "cancel") {
				if (!params.eventId) throw new Error("bg_shell action=cancel requires eventId");
				const event = events.get(params.eventId);
				if (!event) throw new Error(`Unknown background event: ${params.eventId}`);
				if (event.status !== "running")
					return {
						content: [{ type: "text", text: `Event ${event.id} is already ${event.status}.` }],
						details: { id: event.id, status: event.status },
					};

				cancelEvent(event.id, ctx);
				return {
					content: [{ type: "text", text: `Cancelled background event ${event.id}.\nLog: ${event.logPath}` }],
					details: { id: event.id, status: event.status, logPath: event.logPath },
				};
			}

			throw new Error(`Unsupported bg_shell action: ${action}`);
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const event of events.values()) {
			if (event.status !== "running") continue;
			finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by session shutdown");
			killProcessGroup(event, "SIGTERM");
			setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
		}
	});
}
