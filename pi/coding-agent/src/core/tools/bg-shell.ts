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
	MODEL_RESULT_LIMIT_BYTES,
	mergeProgress,
	RESULT_LIMIT_BYTES,
	renderProgressBar,
	type ShellProgress,
	shellQuote,
	stripProgressMarkers,
	TAIL_LIMIT_BYTES,
	timeProgressFraction,
	timestampForFile,
	truncateModelText,
	truncateTail,
} from "../background-shell-utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ExternalActivationReceipt } from "../external-activation-coordinator.ts";

const LOG_DIR = join(getAgentDir(), "tmp", "background-shell");
const TERM_GRACE_MS = 3000;
/**
 * Cap on how many finished (non-running) background-shell events are retained.
 * Prevents the events Map from growing without bound over a long interactive
 * session; running events and events with pending waiters are never evicted.
 */
const MAX_RETAINED_FINISHED_EVENTS = 200;

type BackgroundShellStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type BackgroundShellConfig = {
	defaultTimeoutSeconds?: number;
	defaultReturnToMain: boolean;
	defaultReturnDelivery: ReturnDelivery;
};

type BackgroundShellEvent = {
	id: string;
	command: string;
	cwd: string;
	label?: string;
	logPath: string;
	/** Present for spawned events; absent for an adopted (promoted) bash execution. */
	child?: ChildProcess;
	/** Present for spawned events; absent for an adopted execution that streams elsewhere. */
	log?: WriteStream;
	/** Cancellation for adopted executions with no owned child process. */
	cancel?: () => void;
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
	lastActivityAt: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	activityPhase: string;
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
	/** True while an automatic return-to-main is pending; cleared when the model
	 * consumes the result inline via an id-specific terminal status. */
	autoReturnPending?: boolean;
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

/**
 * Register a completed event's fully-formed return message with the scheduling
 * external-activation coordinator. It decides when the typed payload is
 * committed and reports persistence or rollback through one receipt.
 */
export type BackgroundShellRegisterReturn = (
	eventIds: string[],
	message: { customType: string; content: string; display: boolean; details: unknown },
	delivery: ReturnDelivery,
	receipt: ExternalActivationReceipt,
) => void;

/** Drop a still-pending return from the coordinator after terminal status consumption. */
export type BackgroundShellCancelReturn = (eventIds: string[]) => void;

/** Handle returned by {@link BackgroundShellController.adoptExecution}. */
export type AdoptedExecutionHandle = {
	id: string;
	/** Stream additional output produced after promotion into the event tail. */
	pushOutput: (text: string) => void;
	/** Finalize the adopted execution, triggering the auto-return to the main agent. */
	finish: (result: {
		status: "exited" | "failed" | "timed_out" | "cancelled";
		exitCode?: number | null;
		signal?: NodeJS.Signals | null;
		error?: string;
		tail?: string;
	}) => void;
};

const bgShellSchema = Type.Object(
	{
		action: StringEnum(["start", "status", "cancel", "config"] as const),
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
					"For action=start, automatically send the completed event result back to the main agent and trigger continuation. Default: true.",
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
				description:
					"Background event identifier for action=status/cancel. Parameter name is 'eventId' (not 'id'). Omit for action=status to list all events.",
			}),
		),
		defaultTimeoutSeconds: Type.Optional(
			Type.Number({
				description: "For action=config: set default maximum runtime for future start calls. Use <=0 to clear.",
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
	},
	{ additionalProperties: false },
);

export type BgShellInput = Static<typeof bgShellSchema>;
export type BgShellDetails = Record<string, unknown>;

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatConfig(config: BackgroundShellConfig): string {
	return [
		"Background shell configuration:",
		`defaultTimeoutSeconds: ${config.defaultTimeoutSeconds ?? "none"}`,
		`defaultReturnToMain: ${config.defaultReturnToMain}`,
		`defaultReturnDelivery: ${config.defaultReturnDelivery}`,
	].join("\n");
}

function appendTail(event: BackgroundShellEvent, data: Buffer): void {
	const text = data.toString("utf8");
	const now = Date.now();
	// A marker-only chunk is progress activity, not user-visible output. Strip
	// markers before deciding whether the output timestamp should advance.
	const marker = detectProgressMarker(text);
	const visible = marker !== undefined ? stripProgressMarkers(text) : text;
	if (visible.trim().length > 0) {
		event.lastOutputAt = now;
		event.lastActivityAt = now;
	}
	event.tail = appendTailText(event.tail, Buffer.from(visible, "utf8"));

	if (marker !== undefined) {
		const previous = event.progress?.value;
		event.progress = mergeProgress(event.progress, { value: marker, source: "marker" });
		if (event.progress.value !== previous) {
			event.lastProgressAt = now;
			event.lastActivityAt = now;
		}
		return;
	}
	const detected = detectProgressFromChunk(text);
	if (detected !== undefined) {
		const previous = event.progress?.value;
		event.progress = mergeProgress(event.progress, { value: detected, source: "output" });
		if (event.progress.value !== previous) {
			event.lastProgressAt = now;
			event.lastActivityAt = now;
		}
	}
}

/**
 * The progress to display for an event: the detected reading (marker/output) if
 * present, otherwise a time-based estimate when `expectedSeconds` was given and
 * the event is still running. Returns undefined when nothing is known.
 */
function effectiveProgress(event: BackgroundShellEvent | BackgroundShellEventSnapshot): ShellProgress | undefined {
	if (event.progress) return event.progress;
	if (event.status !== "running" || event.expectedSeconds === undefined) return undefined;
	const value = timeProgressFraction(Date.now() - event.startedAt, event.expectedSeconds);
	return value === undefined ? undefined : { value, source: "time" };
}

/**
 * Kill a captured child/cancel target, escalating a process group first and
 * falling back to the child handle. Callers capture the child reference before
 * finishEvent() releases it, so termination still works after the event object
 * has dropped its own child pointer.
 */
function killTarget(child: ChildProcess | undefined, cancel: (() => void) | undefined, signal: NodeJS.Signals): void {
	// Adopted executions own no child process; cancel through their callback.
	if (!child) {
		cancel?.();
		return;
	}
	const pid = child.pid;
	if (!pid) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

/**
 * Terminate an event's process now (SIGTERM) and escalate to SIGKILL after the
 * grace period. Captures the child/cancel refs up front because finishEvent()
 * releases event.child, and unref()s the escalation timer so a promptly-exiting
 * process cannot keep the event object (or the process table entry) pinned.
 */
function terminateWithGrace(event: BackgroundShellEvent): void {
	const child = event.child;
	const cancel = event.cancel;
	killTarget(child, cancel, "SIGTERM");
	setTimeout(() => killTarget(child, cancel, "SIGKILL"), TERM_GRACE_MS).unref();
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
	if (event.log && !event.log.writableEnded && !event.log.destroyed) event.log.end();
	// Release the ChildProcess reference (and its attached data/error/close
	// listeners) so a retained finished event no longer pins the process object.
	event.child = undefined;

	const waiters = event.waiters.splice(0);
	for (const resolveWaiter of waiters) resolveWaiter();
}

function summarizeEvent(
	event: BackgroundShellEvent | BackgroundShellEventSnapshot,
	includeOutput = true,
	collapsed = false,
	outputLimitBytes = RESULT_LIMIT_BYTES,
): string {
	const elapsedUntil = event.endedAt ?? Date.now();
	const output = truncateTail(event.tail.trimEnd(), outputLimitBytes);
	if (collapsed) {
		const head = `Background job ${event.id}${event.label ? ` (${event.label})` : ""}: ${event.status} (${formatDuration(elapsedUntil - event.startedAt)})`;
		const lines = [head];
		if (event.status === "running") {
			const progress = effectiveProgress(event);
			if (progress) lines.push(`Progress: ${renderProgressBar(progress)}`);
		}
		if (event.error) lines.push(`Error: ${event.error}`);
		if (includeOutput) {
			if (output.text) {
				const outputLineCount = output.text.split("\n").length;
				lines.push(
					`... ${outputLineCount} output ${outputLineCount === 1 ? "line" : "lines"} hidden (ctrl+o to expand)`,
				);
			} else {
				lines.push("(no output)");
			}
		}
		return lines.join("\n");
	}
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
		lines.push(
			"",
			output.truncated
				? `[Output shortened to last ${outputLimitBytes} bytes; full output remains in the log]`
				: "Output:",
			output.text || "(no output yet)",
		);
	}
	return lines.join("\n");
}

export function summarizeEventCollapsed(event: BackgroundShellEvent | BackgroundShellEventSnapshot): string {
	return summarizeEvent(event, true, true);
}

export function summarizeEventExpanded(event: BackgroundShellEvent | BackgroundShellEventSnapshot): string {
	return summarizeEvent(event, true, false, TAIL_LIMIT_BYTES);
}

/** Bounded complete summary sent to the model; the TUI can still expand eventData. */
function summarizeEventForModel(
	event: BackgroundShellEvent | BackgroundShellEventSnapshot,
	maxBytes = MODEL_RESULT_LIMIT_BYTES,
): string {
	return truncateModelText(summarizeEvent(event, true, false, maxBytes), maxBytes).text;
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
> &
	Partial<Pick<BackgroundShellEvent, "lastActivityAt" | "lastOutputAt" | "lastProgressAt" | "activityPhase">>;

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
		lastActivityAt: event.lastActivityAt,
		lastOutputAt: event.lastOutputAt,
		lastProgressAt: event.lastProgressAt,
		activityPhase: event.activityPhase,
	};
}

function waitForEventCompletion(event: BackgroundShellEvent): Promise<void> {
	if (event.status !== "running") return Promise.resolve();
	return new Promise((resolveWait) => event.waiters.push(resolveWait));
}

export class BackgroundShellController {
	private nextEventNumber = 1;
	private shuttingDown = false;
	private events = new Map<string, BackgroundShellEvent>();
	private shellConfig: BackgroundShellConfig = {
		defaultReturnToMain: true,
		defaultReturnDelivery: "followUp",
	};
	private monitor: { update: (ctx?: ExtensionContext) => void };
	private registerReturn: BackgroundShellRegisterReturn;
	private cancelReturn: BackgroundShellCancelReturn;
	private maxRetainedFinishedEvents = MAX_RETAINED_FINISHED_EVENTS;

	constructor(
		manager: BackgroundEventManager,
		options: {
			registerReturn: BackgroundShellRegisterReturn;
			cancelReturn: BackgroundShellCancelReturn;
			/** Override the finished-event retention cap (primarily for tests). */
			maxRetainedFinishedEvents?: number;
		},
	) {
		this.registerReturn = options.registerReturn;
		this.cancelReturn = options.cancelReturn;
		if (options.maxRetainedFinishedEvents !== undefined && options.maxRetainedFinishedEvents >= 0) {
			this.maxRetainedFinishedEvents = options.maxRetainedFinishedEvents;
		}
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
					expectedSeconds: event.expectedSeconds,
					lastActivityAt: event.lastActivityAt,
					lastOutputAt: event.lastOutputAt,
					lastProgressAt: event.lastProgressAt,
					activityPhase: event.activityPhase,
					reminderEligible: event.status === "running",
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

	/**
	 * Adopt an already-running execution (e.g. a foreground bash tool call promoted
	 * to the background after exceeding its inline deadline). No child process is
	 * owned here: the caller supplies the current output tail, a cancel callback,
	 * and streams later output through the returned handle. The completion is
	 * finalized via {@link AdoptedExecutionHandle.finish}. The result is always
	 * auto-returned to the main agent as a follow-up so promoted work is never
	 * silently lost.
	 */
	adoptExecution(
		options: {
			command: string;
			cwd: string;
			startedAt: number;
			tail?: string;
			logPath?: string;
			label?: string;
			expectedSeconds?: number;
			cancel: () => void;
			returnDelivery?: ReturnDelivery;
			returnInstruction?: string;
		},
		ctx?: ExtensionContext,
	): AdoptedExecutionHandle {
		const id = `bg_${String(this.nextEventNumber++).padStart(3, "0")}`;
		const now = Date.now();
		const event: BackgroundShellEvent = {
			id,
			command: options.command,
			cwd: options.cwd,
			label: options.label,
			logPath: options.logPath ?? "",
			cancel: options.cancel,
			startedAt: options.startedAt,
			status: "running",
			exitCode: null,
			signal: null,
			tail: options.tail ?? "",
			expectedSeconds: options.expectedSeconds,
			lastActivityAt: now,
			lastOutputAt: options.tail?.trim() ? now : undefined,
			activityPhase: "running",
			waiters: [],
		};
		this.events.set(id, event);
		this.monitor.update(ctx);

		const delivery = options.returnDelivery ?? this.shellConfig.defaultReturnDelivery;
		this.scheduleReturnToMain(event, delivery, options.returnInstruction);

		return {
			id,
			pushOutput: (text: string) => {
				if (event.status !== "running") return;
				appendTail(event, Buffer.from(text, "utf8"));
				this.monitor.update(ctx);
			},
			finish: (result: {
				status: Exclude<BackgroundShellStatus, "running">;
				exitCode?: number | null;
				signal?: NodeJS.Signals | null;
				error?: string;
				tail?: string;
			}) => {
				if (event.status !== "running") return;
				if (result.tail !== undefined) event.tail = result.tail;
				finishEvent(event, result.status, result.exitCode ?? null, result.signal ?? null, result.error);
				this.monitor.update(ctx);
			},
		};
	}

	createToolDefinition(): ToolDefinition<typeof bgShellSchema, BgShellDetails> {
		return {
			name: "bg_shell",
			label: "Background Shell",
			renderKind: "bg-shell",
			description:
				"Manage non-interactive shell commands as background events. Use action=start for long-running commands; set returnToMain=true to automatically send the completed result back to the main agent. Use action=status for an immediate snapshot, action=cancel to terminate a running event, and action=config to inspect or update session defaults. This tool intentionally exposes no blocking wait action.",
			promptSnippet: "Start, inspect, or cancel long-running shell commands as background events",
			promptGuidelines: [
				"Use bg_shell action=start for long-running commands such as builds, tests, dev servers, migrations, downloads, or commands expected to take more than about 10 seconds.",
				"Use the regular bash tool for short one-off shell commands.",
				"After bg_shell action=start, continue only non-overlapping independent work. Do not rerun the same command, duplicate its purpose, or poll action=status. When a later step depends on the result, rely on returnToMain=true to deliver the completion receipt and activate a later turn.",
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
			terminateWithGrace(event);
			finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by session shutdown");
		}
		this.monitor.update();
	}

	private cancelEvent(id: string, ctx?: ExtensionContext): boolean {
		const event = this.events.get(id);
		if (!event || event.status !== "running") return false;
		terminateWithGrace(event);
		finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by background events UI");
		this.monitor.update(ctx);
		return true;
	}

	/**
	 * Bound the events Map: keep every running event (and anything still awaited),
	 * plus the most recent finished events up to MAX_RETAINED_FINISHED_EVENTS.
	 * Finished events are evicted oldest-first by endedAt. Mirrors the retention
	 * discipline the sub-agent controller applies to its own progress map.
	 */
	private pruneFinishedEvents(): void {
		const finished = [...this.events.values()].filter(
			(event) => event.status !== "running" && event.waiters.length === 0 && !event.autoReturnPending,
		);
		if (finished.length <= this.maxRetainedFinishedEvents) return;
		finished.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
		for (const event of finished.slice(0, finished.length - this.maxRetainedFinishedEvents)) {
			this.events.delete(event.id);
		}
	}

	private returnShellResultToMain(event: BackgroundShellEvent, delivery: ReturnDelivery, instruction?: string): void {
		if (this.shuttingDown) return;
		const defaultInstruction =
			"Background shell event has completed. Read this returned result, use it to continue the original task, and do not ask the user to manually inspect the event id unless more information is needed.";
		const resolvedInstruction = instruction?.trim() || defaultInstruction;
		const instructionBudget = Math.floor(MODEL_RESULT_LIMIT_BYTES / 4);
		const boundedInstruction = truncateModelText(resolvedInstruction, instructionBudget).text;
		const separatorBytes = Buffer.byteLength("\n\n", "utf8");
		const summaryBudget = Math.max(
			1024,
			MODEL_RESULT_LIMIT_BYTES - Buffer.byteLength(boundedInstruction, "utf8") - separatorBytes,
		);
		const content = truncateModelText(
			`${boundedInstruction}\n\n${summarizeEventForModel(event, summaryBudget)}`,
			MODEL_RESULT_LIMIT_BYTES,
		).text;
		// Hand the fully-formed, byte-bounded message to the scheduling layer. The
		// coordinator coalesces it with other near-simultaneous returns into one turn;
		// this controller never decides WHEN it is injected.
		this.registerReturn(
			[event.id],
			{
				customType: "bg-shell-return",
				// Keep only a bounded tail in model context. The TUI renderer regenerates
				// the expandable view from eventData, and the log retains complete output.
				content,
				display: true,
				details: {
					id: event.id,
					status: event.status,
					exitCode: event.exitCode,
					logPath: event.logPath,
					instruction: boundedInstruction,
					// A plain-data snapshot only — the live event holds a ChildProcess,
					// WriteStream, Timer, and waiter callbacks that cannot be structured-cloned
					// when this message is delivered to the main agent.
					eventData: serializableEventSnapshot(event),
				},
			},
			delivery,
			{
				onPersisted: () => {
					event.autoReturnPending = false;
					this.pruneFinishedEvents();
				},
				onDropped: () => {
					event.autoReturnPending = false;
					this.pruneFinishedEvents();
				},
			},
		);
	}

	private scheduleReturnToMain(event: BackgroundShellEvent, delivery: ReturnDelivery, instruction?: string): void {
		// Mark the event as awaiting an auto-return. If the model synchronously
		// consumes the result through an id-specific terminal status, that handler
		// clears the flag so we do not redundantly deliver + trigger a turn.
		event.autoReturnPending = true;
		void waitForEventCompletion(event)
			.then(async () => {
				// Yield once so terminal status consumption on the same tick as completion
				// clears the flag before we read it (avoids a duplicate delivery race).
				await Promise.resolve();
				if (!event.autoReturnPending) return;
				this.returnShellResultToMain(event, delivery, instruction);
			})
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
			if (typeof params.defaultReturnToMain === "boolean")
				this.shellConfig.defaultReturnToMain = params.defaultReturnToMain;
			if (params.defaultReturnDelivery) this.shellConfig.defaultReturnDelivery = params.defaultReturnDelivery;
			const content = truncateModelText(formatConfig(this.shellConfig), MODEL_RESULT_LIMIT_BYTES).text;
			return {
				content: [{ type: "text" as const, text: content }],
				details: { action, ...this.shellConfig },
			};
		}

		if (action === "start") {
			return this.start(params, signal, ctx, returnToMain, returnDelivery, returnInstruction);
		}

		if (action === "status") {
			return this.status(params);
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
		if (signal?.aborted)
			return {
				content: [{ type: "text" as const, text: "Cancelled before start" }],
				details: { action: "start", status: "cancelled" },
			};

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

		const startedAt = Date.now();
		const event: BackgroundShellEvent = {
			id,
			command: params.command,
			cwd,
			label: params.label,
			logPath,
			child,
			log,
			startedAt,
			status: "running",
			exitCode: null,
			signal: null,
			tail: "",
			expectedSeconds: positiveNumber(params.expectedSeconds),
			lastActivityAt: startedAt,
			activityPhase: "running",
			waiters: [],
		};
		this.events.set(id, event);
		this.monitor.update(ctx);

		log.write(`$ cd ${shellQuote(cwd)} && ${params.command}\n\n`);
		child.stdout?.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(event, data);
			this.monitor.update(ctx);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(event, data);
			this.monitor.update(ctx);
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
				terminateWithGrace(event);
				finishEvent(event, "timed_out", null, "SIGTERM", `Timed out after ${timeoutSeconds}s`);
				this.monitor.update(ctx);
			}, timeoutSeconds * 1000);
		}

		if (returnToMain) this.scheduleReturnToMain(event, returnDelivery, returnInstruction);
		// Evict old finished events so the Map cannot grow without bound over a long session.
		this.pruneFinishedEvents();

		const content = truncateModelText(
			`Started background event ${id}${returnToMain ? " with automatic return to main agent" : ""}\nCommand: ${params.command}\nCWD: ${cwd}\nLog: ${logPath}${timeoutSeconds ? `\nTimeout: ${timeoutSeconds}s` : ""}`,
			MODEL_RESULT_LIMIT_BYTES,
		).text;
		return {
			content: [
				{
					type: "text" as const,
					text: content,
				},
			],
			details: {
				action: "start",
				id,
				command: params.command,
				cwd,
				logPath,
				status: "running",
				returnsToMain: returnToMain,
				timeoutSeconds,
				eventData: serializableEventSnapshot(event),
			},
		};
	}

	private status(params: BgShellInput) {
		if (!params.eventId) {
			const lines = [...this.events.values()].map((event) => {
				const elapsedUntil = event.endedAt ?? Date.now();
				return `${event.id}\t${event.status}\t${formatDuration(elapsedUntil - event.startedAt)}\t${event.label ?? event.command}`;
			});
			const content = truncateModelText(
				lines.length ? lines.join("\n") : "No background events.",
				MODEL_RESULT_LIMIT_BYTES,
			).text;
			return {
				content: [{ type: "text" as const, text: content }],
				details: {
					action: "status",
					events: lines.length,
					eventsData: [...this.events.values()].map(serializableEventSnapshot),
				},
			};
		}

		const event = this.events.get(params.eventId);
		if (!event)
			throw new Error(
				truncateModelText(`Unknown background event: ${params.eventId}`, MODEL_RESULT_LIMIT_BYTES).text,
			);
		this.consumePendingAutoReturn(event);
		return {
			content: [{ type: "text" as const, text: summarizeEventForModel(event) }],
			details: {
				action: "status",
				id: event.id,
				status: event.status,
				exitCode: event.exitCode,
				logPath: event.logPath,
				eventData: serializableEventSnapshot(event),
			},
		};
	}

	private consumePendingAutoReturn(event: BackgroundShellEvent): void {
		// An id-specific terminal status shows the model the full result inline;
		// consume the pending auto-return so it is not delivered twice.
		if (event.status !== "running" && event.autoReturnPending) {
			event.autoReturnPending = false;
			this.cancelReturn([event.id]);
		}
	}

	private cancel(params: BgShellInput, ctx: ExtensionContext) {
		if (!params.eventId) throw new Error("bg_shell action=cancel requires eventId");
		const event = this.events.get(params.eventId);
		if (!event)
			throw new Error(
				truncateModelText(`Unknown background event: ${params.eventId}`, MODEL_RESULT_LIMIT_BYTES).text,
			);
		if (event.status !== "running") {
			const content = truncateModelText(
				`Event ${event.id} is already ${event.status}.`,
				MODEL_RESULT_LIMIT_BYTES,
			).text;
			return {
				content: [{ type: "text" as const, text: content }],
				details: {
					action: "cancel",
					id: event.id,
					status: event.status,
					eventData: serializableEventSnapshot(event),
				},
			};
		}

		this.cancelEvent(event.id, ctx);
		const content = truncateModelText(
			`Cancelled background event ${event.id}.\nLog: ${event.logPath}`,
			MODEL_RESULT_LIMIT_BYTES,
		).text;
		return {
			content: [{ type: "text" as const, text: content }],
			details: {
				action: "cancel",
				id: event.id,
				status: event.status,
				logPath: event.logPath,
				eventData: serializableEventSnapshot(event),
			},
		};
	}
}
