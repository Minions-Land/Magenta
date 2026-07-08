import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { BackgroundEventManager } from "../background-events.ts";
import {
	appendTail as appendTailText,
	detectProgressFromChunk,
	detectProgressMarker,
	formatDuration,
	mergeProgress,
	RESULT_LIMIT_BYTES,
	renderProgressBar,
	type ShellProgress,
	shellQuote,
	stripProgressMarkers,
	timeProgressFraction,
	timestampForFile,
	truncateTail,
} from "../background-shell-utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const LOG_DIR = join(getAgentDir(), "tmp", "background-shell");
const TERM_GRACE_MS = 3000;

type BackgroundShellStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type BackgroundShellConfig = {
	defaultTimeoutSeconds?: number;
	defaultWaitTimeoutSeconds?: number;
	defaultReturnToMain: boolean;
	defaultReturnDelivery: ReturnDelivery;
};

type BackgroundShellEvent = {
	id: string;
	command: string;
	cwd: string;
	label?: string;
	logPath: string;
	child: ChildProcess;
	log: WriteStream;
	startedAt: number;
	endedAt?: number;
	status: BackgroundShellStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	/** Latest progress reading (value + source), if any has been detected. */
	progress?: ShellProgress;
	/** Optional expected runtime in seconds, enabling time-based progress fallback. */
	expectedSeconds?: number;
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
};

export type BackgroundShellReturnMessage<T = unknown> = {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: T;
	};
	options: { triggerTurn?: boolean; deliverAs?: ReturnDelivery };
};

export type BackgroundShellSendMessage = <T = unknown>(
	message: BackgroundShellReturnMessage<T>["message"],
	options?: BackgroundShellReturnMessage<T>["options"],
) => Promise<void> | void;

const bgShellSchema = Type.Object({
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
	expectedSeconds: Type.Optional(
		Type.Number({
			description:
				"For action=start, the expected runtime in seconds. When the command emits no progress of its own, a time-based estimate is shown (hinted as an estimate). Real progress from output or an @@progress marker always takes precedence.",
		}),
	),
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
});

export type BgShellInput = Static<typeof bgShellSchema>;
export type BgShellDetails = Record<string, unknown>;

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

function appendTail(event: BackgroundShellEvent, data: Buffer): void {
	const text = data.toString("utf8");
	// Explicit `@@progress` markers are authoritative and must not leak into the
	// visible tail, so strip them before buffering the output.
	const marker = detectProgressMarker(text);
	const visible = marker !== undefined ? stripProgressMarkers(text) : text;
	event.tail = appendTailText(event.tail, Buffer.from(visible, "utf8"));

	if (marker !== undefined) {
		event.progress = mergeProgress(event.progress, { value: marker, source: "marker" });
		return;
	}
	const detected = detectProgressFromChunk(text);
	if (detected !== undefined) {
		event.progress = mergeProgress(event.progress, { value: detected, source: "output" });
	}
}

/**
 * The progress to display for an event: the detected reading (marker/output) if
 * present, otherwise a time-based estimate when `expectedSeconds` was given and
 * the event is still running. Returns undefined when nothing is known.
 */
function effectiveProgress(event: BackgroundShellEvent): ShellProgress | undefined {
	if (event.progress) return event.progress;
	if (event.status !== "running" || event.expectedSeconds === undefined) return undefined;
	const value = timeProgressFraction(Date.now() - event.startedAt, event.expectedSeconds);
	return value === undefined ? undefined : { value, source: "time" };
}

function killProcessGroup(event: BackgroundShellEvent, signal: NodeJS.Signals): void {
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
	event: BackgroundShellEvent,
	status: BackgroundShellStatus,
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

function summarizeEvent(event: BackgroundShellEvent, includeOutput = true, collapsed = false): string {
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
	if (event.status === "running") {
		const progress = effectiveProgress(event);
		if (progress) lines.splice(5, 0, `Progress: ${renderProgressBar(progress)}`);
	}
	if (event.error) lines.push(`Error: ${event.error}`);
	if (includeOutput) {
		if (collapsed && output.text) {
			// Collapsed mode: show count of output lines with expand hint
			const outputLineCount = output.text.split("\n").length;
			lines.push(
				"",
				`... ${outputLineCount} output ${outputLineCount === 1 ? "line" : "lines"} hidden (ctrl+o to expand)`,
			);
		} else {
			lines.push(
				"",
				output.truncated ? `[Output truncated to last ${RESULT_LIMIT_BYTES} bytes]` : "Output:",
				output.text || "(no output yet)",
			);
		}
	}
	return lines.join("\n");
}

export function summarizeEventCollapsed(event: BackgroundShellEvent): string {
	return summarizeEvent(event, true, true);
}

export function summarizeEventExpanded(event: BackgroundShellEvent): string {
	return summarizeEvent(event, true, false);
}

/**
 * Plain-data view of an event, safe to pass through structuredClone/postMessage.
 * The live event holds a ChildProcess, a WriteStream, a Timer, and waiter
 * callbacks — none of which are cloneable — so message payloads must only carry
 * this snapshot, never the event itself.
 */
export type BackgroundShellEventSnapshot = Pick<
	BackgroundShellEvent,
	| "id"
	| "command"
	| "cwd"
	| "label"
	| "logPath"
	| "startedAt"
	| "endedAt"
	| "status"
	| "exitCode"
	| "signal"
	| "error"
	| "tail"
	| "progress"
	| "expectedSeconds"
>;

export function serializableEventSnapshot(event: BackgroundShellEvent): BackgroundShellEventSnapshot {
	return {
		id: event.id,
		command: event.command,
		cwd: event.cwd,
		label: event.label,
		logPath: event.logPath,
		startedAt: event.startedAt,
		endedAt: event.endedAt,
		status: event.status,
		exitCode: event.exitCode,
		signal: event.signal,
		error: event.error,
		tail: event.tail,
		progress: event.progress,
		expectedSeconds: event.expectedSeconds,
	};
}

function waitForEvent(
	event: BackgroundShellEvent,
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

export class BackgroundShellController {
	private nextEventNumber = 1;
	private shuttingDown = false;
	private events = new Map<string, BackgroundShellEvent>();
	private shellConfig: BackgroundShellConfig = {
		defaultReturnToMain: false,
		defaultReturnDelivery: "followUp",
	};
	private monitor: { update: (ctx?: ExtensionContext) => void };
	private sendMessage: BackgroundShellSendMessage;

	constructor(manager: BackgroundEventManager, options: { sendMessage: BackgroundShellSendMessage }) {
		this.sendMessage = options.sendMessage;
		this.monitor = manager.registerSource({
			id: "shell",
			title: "shell",
			getEvents: () =>
				[...this.events.values()].map((event) => ({
					id: event.id,
					status: event.status,
					startedAt: event.startedAt,
					endedAt: event.endedAt,
					label: event.label ?? event.command,
					cwd: event.cwd,
					logPath: event.logPath,
					tail: event.tail,
					progress: effectiveProgress(event),
					canCancel: event.status === "running",
				})),
			getEventDetails: (id) => {
				const event = this.events.get(id);
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
			cancelEvent: (id, ctx) => this.cancelEvent(id, ctx),
		});
	}

	createToolDefinition(): ToolDefinition<typeof bgShellSchema, BgShellDetails> {
		return {
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
				"Progress bars are shown automatically when a command prints percentages or `[n/total]` counters. For exact progress from your own scripts, print lines like `@@progress 0.42` (these are hidden from the output tail). For opaque long tasks, pass expectedSeconds to show a time-based estimate.",
			],
			parameters: bgShellSchema,
			execute: (_toolCallId, params, signal, _onUpdate, ctx) => this.execute(params, signal, ctx),
		};
	}

	shutdown(): void {
		this.shuttingDown = true;
		for (const event of this.events.values()) {
			if (event.status !== "running") continue;
			finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by session shutdown");
			killProcessGroup(event, "SIGTERM");
			setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
		}
		this.monitor.update();
	}

	private cancelEvent(id: string, ctx?: ExtensionContext): boolean {
		const event = this.events.get(id);
		if (!event || event.status !== "running") return false;
		finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by background events UI");
		this.monitor.update(ctx);
		killProcessGroup(event, "SIGTERM");
		setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
		return true;
	}

	private returnShellResultToMain(event: BackgroundShellEvent, delivery: ReturnDelivery, instruction?: string): void {
		if (this.shuttingDown) return;
		const defaultInstruction =
			"Background shell event has completed. Read this returned result, use it to continue the original task, and do not ask the user to manually inspect the event id unless more information is needed.";
		void this.sendMessage(
			{
				customType: "bg-shell-return",
				content: `${instruction?.trim() || defaultInstruction}\n\n${summarizeEventCollapsed(event)}`,
				display: true,
				details: {
					id: event.id,
					status: event.status,
					exitCode: event.exitCode,
					logPath: event.logPath,
					// A plain-data snapshot only — the live event holds a ChildProcess,
					// WriteStream, Timer, and waiter callbacks that cannot be structured-cloned
					// when this message is delivered to the main agent.
					eventData: serializableEventSnapshot(event),
				},
			},
			{ deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
		);
	}

	private scheduleReturnToMain(event: BackgroundShellEvent, delivery: ReturnDelivery, instruction?: string): void {
		void waitForEvent(event, undefined, undefined)
			.then(() => this.returnShellResultToMain(event, delivery, instruction))
			.catch(() => undefined);
	}

	private async execute(params: BgShellInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		const action = params.action;
		const returnToMain = params.returnToMain ?? this.shellConfig.defaultReturnToMain;
		const returnDelivery = (params.returnDelivery ?? this.shellConfig.defaultReturnDelivery) as ReturnDelivery;
		const returnInstruction = params.returnInstruction as string | undefined;

		if (action === "config") {
			if ("defaultTimeoutSeconds" in params)
				this.shellConfig.defaultTimeoutSeconds = positiveNumber(params.defaultTimeoutSeconds);
			if ("defaultWaitTimeoutSeconds" in params)
				this.shellConfig.defaultWaitTimeoutSeconds = positiveNumber(params.defaultWaitTimeoutSeconds);
			if (typeof params.defaultReturnToMain === "boolean")
				this.shellConfig.defaultReturnToMain = params.defaultReturnToMain;
			if (params.defaultReturnDelivery) this.shellConfig.defaultReturnDelivery = params.defaultReturnDelivery;
			return {
				content: [{ type: "text" as const, text: formatConfig(this.shellConfig) }],
				details: { ...this.shellConfig },
			};
		}

		if (action === "start") {
			return this.start(params, signal, ctx, returnToMain, returnDelivery, returnInstruction);
		}

		if (action === "status") {
			return this.status(params);
		}

		if (action === "wait") {
			return this.wait(params, signal);
		}

		if (action === "cancel") {
			return this.cancel(params, ctx);
		}

		throw new Error(`Unsupported bg_shell action: ${action}`);
	}

	private async start(
		params: BgShellInput,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		returnToMain: boolean,
		returnDelivery: ReturnDelivery,
		returnInstruction: string | undefined,
	) {
		if (!params.command) throw new Error("bg_shell action=start requires command");
		if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled before start" }], details: {} };

		await mkdir(LOG_DIR, { recursive: true });

		const id = `bg_${String(this.nextEventNumber++).padStart(3, "0")}`;
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

		const event: BackgroundShellEvent = {
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
			expectedSeconds: positiveNumber(params.expectedSeconds),
			waiters: [],
		};
		this.events.set(id, event);
		this.monitor.update(ctx);

		log.write(`$ cd ${shellQuote(cwd)} && ${params.command}\n\n`);
		child.stdout?.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(event, data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(event, data);
		});
		child.on("error", (error) => {
			finishEvent(event, "failed", null, null, error.message);
			this.monitor.update(ctx);
		});
		child.on("close", (code, closeSignal) => {
			const timedOut = event.status === "timed_out";
			const cancelled = event.status === "cancelled";
			if (timedOut || cancelled) return;
			finishEvent(event, code === 0 ? "exited" : "failed", code, closeSignal);
			this.monitor.update(ctx);
			try {
				ctx.ui.notify(
					`Background event ${id} finished: ${event.status}${code === null ? "" : ` (${code})`}`,
					code === 0 ? "info" : "warning",
				);
			} catch {
				// UI may no longer be available.
			}
		});

		const timeoutSeconds = positiveNumber(params.timeoutSeconds) ?? this.shellConfig.defaultTimeoutSeconds;
		if (timeoutSeconds) {
			event.timeout = setTimeout(() => {
				finishEvent(event, "timed_out", null, "SIGTERM", `Timed out after ${timeoutSeconds}s`);
				this.monitor.update(ctx);
				killProcessGroup(event, "SIGTERM");
				setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
			}, timeoutSeconds * 1000);
		}

		if (returnToMain) this.scheduleReturnToMain(event, returnDelivery, returnInstruction);

		return {
			content: [
				{
					type: "text" as const,
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

	private status(params: BgShellInput) {
		if (!params.eventId) {
			const lines = [...this.events.values()].map((event) => {
				const elapsedUntil = event.endedAt ?? Date.now();
				return `${event.id}\t${event.status}\t${formatDuration(elapsedUntil - event.startedAt)}\t${event.label ?? event.command}`;
			});
			return {
				content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No background events." }],
				details: { events: lines.length },
			};
		}

		const event = this.events.get(params.eventId);
		if (!event) throw new Error(`Unknown background event: ${params.eventId}`);
		return {
			content: [{ type: "text" as const, text: summarizeEvent(event) }],
			details: { id: event.id, status: event.status, exitCode: event.exitCode, logPath: event.logPath },
		};
	}

	private async wait(params: BgShellInput, signal: AbortSignal | undefined) {
		if (!params.eventId) throw new Error("bg_shell action=wait requires eventId");
		const event = this.events.get(params.eventId);
		if (!event) throw new Error(`Unknown background event: ${params.eventId}`);

		const waitTimeoutSeconds =
			positiveNumber(params.waitTimeoutSeconds) ?? this.shellConfig.defaultWaitTimeoutSeconds;
		const result = await waitForEvent(event, waitTimeoutSeconds, signal);
		if (result === "aborted") {
			return {
				content: [
					{
						type: "text" as const,
						text: `Wait cancelled. Event ${event.id} is still ${event.status}.\nLog: ${event.logPath}`,
					},
				],
				details: { id: event.id, status: event.status },
			};
		}
		if (result === "timeout") {
			return {
				content: [
					{
						type: "text" as const,
						text: `Wait timed out. Event ${event.id} is still running.\n\n${summarizeEvent(event)}`,
					},
				],
				details: { id: event.id, status: event.status, logPath: event.logPath },
			};
		}

		return {
			content: [{ type: "text" as const, text: summarizeEvent(event) }],
			details: { id: event.id, status: event.status, exitCode: event.exitCode, logPath: event.logPath },
		};
	}

	private cancel(params: BgShellInput, ctx: ExtensionContext) {
		if (!params.eventId) throw new Error("bg_shell action=cancel requires eventId");
		const event = this.events.get(params.eventId);
		if (!event) throw new Error(`Unknown background event: ${params.eventId}`);
		if (event.status !== "running") {
			return {
				content: [{ type: "text" as const, text: `Event ${event.id} is already ${event.status}.` }],
				details: { id: event.id, status: event.status },
			};
		}

		this.cancelEvent(event.id, ctx);
		return {
			content: [{ type: "text" as const, text: `Cancelled background event ${event.id}.\nLog: ${event.logPath}` }],
			details: { id: event.id, status: event.status, logPath: event.logPath },
		};
	}
}
