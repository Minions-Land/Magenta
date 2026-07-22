import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import {
	type BoundedLogState,
	BufferedBoundedLog,
	cleanupLogTree,
	createBoundedLogState,
	DEFAULT_LOG_MAX_AGE_MS,
	DEFAULT_LOG_MAX_FILES,
	DEFAULT_LOG_MAX_TOTAL_BYTES,
} from "../../../_magenta/log-retention.ts";
import {
	NODE_MAX_TIMEOUT_SECONDS,
	nodeTimeoutSecondsToMs,
	validateNodeTimeoutSeconds,
} from "../../../_magenta/timeout.ts";
import { ToolExecutionError } from "../../tool-error.ts";
import {
	appendTail as appendTailText,
	formatDuration,
	MODEL_RESULT_LIMIT_BYTES,
	MODEL_RESULT_TOTAL_LIMIT_BYTES,
	RESULT_LIMIT_BYTES,
	TAIL_LIMIT_BYTES,
	timestampForFile,
	truncateModelText,
	truncateTail,
	Utf8TailDecoder,
} from "./background-utils.ts";
import type {
	OrchestrationRequest as MultiAgentOrchestrationRequest,
	OrchestrationResult as MultiAgentOrchestrationResult,
	WorkerUsage,
} from "./workflow-types.ts";

const APP_NAME = "Magenta";
const WORK_DIR_ROOT = join(process.cwd(), ".magenta", "tmp", "sub-agents");
const ACTIVE_SUB_AGENT_ARTIFACTS = new Set<string>();
const TERM_GRACE_MS = 3000;
export const MAIN_PROGRESS_WRITE_INTERVAL_MS = 1_000;
/**
 * Cap on how many finished (non-running) sub-agent events are retained.
 * Prevents unbounded growth of the events Map over a long interactive session;
 * running events and events with pending waiters are never evicted.
 */
const MAX_RETAINED_FINISHED_EVENTS = 200;
const MAX_START_MANY = 8;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const FORBIDDEN_SUB_AGENT_TOOLS = new Set(["sub_agent", "bg_shell", "multiagent"]);
const DEFAULT_THINKING = "medium";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type AgentStatus = "queued" | "starting" | "running" | "terminating" | "exited" | "failed" | "timed_out" | "cancelled";
type RequestedTerminalStatus = Extract<AgentStatus, "failed" | "timed_out" | "cancelled">;
type SubAgentOutputStream = "stdout" | "stderr" | "single";

type TerminationRequest = {
	status: RequestedTerminalStatus;
	error: string;
	signal: NodeJS.Signals | null;
};
type Action = "start" | "status" | "cancel";
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type SubAgentConfig = {
	defaultTimeoutSeconds?: number;
	defaultReturnDelivery: ReturnDelivery;
	defaultThinking: ThinkingLevel;
};

type MainToolProgress = {
	id: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	status: "running" | "finished";
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
};

type AgentTask = {
	task: string;
	role?: string;
	label?: string;
	cwd?: string;
	tools?: string[];
	packages?: string[];
	model?: string;
	provider?: string;
	thinking?: ThinkingLevel;
	timeoutSeconds?: number;
};

type WorkflowInput = Static<typeof WorkflowSchema>;

type PendingStart = {
	eventId: string;
	parentCwd: string;
	task?: AgentTask;
	workflow?: WorkflowInput;
	deadlineAt?: number;
};

type SubAgentEvent = {
	id: string;
	task: string;
	role?: string;
	label?: string;
	cwd: string;
	tools: string[];
	packages?: string[];
	model?: string;
	provider?: string;
	thinking: ThinkingLevel;
	promptPath: string;
	logPath: string;
	/** Event driver kind. "agent" = one child process; "workflow" = in-process orchestration. */
	kind: "agent" | "workflow";
	/** Present for kind="agent": the headless child process. */
	child?: ChildProcess;
	/** Present for kind="workflow": aborts the in-process orchestration on cancel. */
	abort?: AbortController;
	/** Present for kind="workflow": pattern name for labeling/details. */
	pattern?: string;
	/** Present for kind="workflow" once finished: the structured orchestration result. */
	workflowResult?: MultiAgentOrchestrationResult;
	log: BufferedBoundedLog | null;
	logState: BoundedLogState;
	queuedAt: number;
	startedAt: number;
	runningAt?: number;
	endedAt?: number;
	status: AgentStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	outputDecoders: Record<SubAgentOutputStream, Utf8TailDecoder>;
	lastActivityAt: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	activityPhase: string;
	timeout?: NodeJS.Timeout;
	graceKillTimer?: NodeJS.Timeout;
	terminationRequest?: TerminationRequest;
	waiters: Array<() => void>;
	/** True while terminal delivery to the parent is pending. */
	autoReturnPending?: boolean;
};

export type SubAgentSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type SubAgentInvocationResolver = (args: string[]) => { command: string; args: string[] };
export type HostToolContext = { cwd: string };
export type ExternalActivationReceipt = {
	onPersisted: () => void;
	onDropped: (error: unknown) => void;
};
export type AgentSessionEvent =
	| { type: "agent_start" }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };
export type BackgroundEventSnapshot = {
	id: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	label: string;
	cwd?: string;
	logPath?: string;
	tail?: string;
	lastActivityAt?: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	activityPhase?: string;
	reminderEligible?: boolean;
	canCancel?: boolean;
};

export type BackgroundEventManagerPort = {
	registerSource(source: {
		id: string;
		title: string;
		getEvents: () => BackgroundEventSnapshot[];
		getEventDetails?: (id: string) => string[];
		cancelEvent?: (id: string, context?: HostToolContext) => boolean;
	}): { update: () => void; dispose?: () => void };
};

export type SubAgentModelSelection = {
	provider: string;
	model: string;
};

/** The HCP-selected multiagent capability surface consumed by this facade. */
export type SubAgentWorkflowProvider = {
	orchestrate(request: MultiAgentOrchestrationRequest, signal?: AbortSignal): Promise<MultiAgentOrchestrationResult>;
};

export type SubAgentReturnMessage<T = unknown> = {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: T;
	};
	options: { triggerTurn?: boolean; deliverAs?: ReturnDelivery };
};

/**
 * Register one completed event's return message with the scheduling external-
 * activation coordinator. Independent records may still be coalesced into one
 * delivery turn by the coordinator.
 */
export type SubAgentRegisterReturn = (
	eventIds: string[],
	message: { customType: string; content: string; display: boolean; details: unknown },
	delivery: ReturnDelivery,
	receipt: ExternalActivationReceipt,
) => void;

/** Drop a pending return during shutdown or internal compatibility handling. */
export type SubAgentCancelReturn = (eventIds: string[]) => void;

/**
 * A workflow slot: one sessionless, one-shot worker in an orchestration. It
 * shares task/role/model/provider/tools/thinking with a plain sub-agent task,
 * plus the orchestration-only `focus`. Structured
 * output `schema` for verifier/judge/evaluator slots is enforced by the harness
 * preset and is intentionally NOT exposed here — the LLM fills content, never
 * the control-flow-critical output contract.
 */
const WorkflowSlotSchema = Type.Object({
	task: Type.String({ description: "What this worker does (LLM-supplied task content)." }),
	role: Type.Optional(Type.String({ description: "Optional role hint for this worker." })),
	focus: Type.Optional(Type.String({ description: "Optional standard/criteria this worker must attend to." })),
	model: Type.Optional(Type.String({ description: "Model override for this worker (e.g. a stronger judge model)." })),
	provider: Type.Optional(Type.String({ description: "Provider override for this worker." })),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: `Tool whitelist for this worker. Defaults to read-only.` }),
	),
	packages: Type.Optional(
		Type.Array(Type.String(), { description: "Harness package selectors granted to this workflow worker." }),
	),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: `Optional per-worker hard wall-clock deadline in seconds. Omit for no worker deadline. Maximum ${NODE_MAX_TIMEOUT_SECONDS} seconds.`,
			exclusiveMinimum: 0,
			maximum: NODE_MAX_TIMEOUT_SECONDS,
		}),
	),
});

/**
 * A workflow orchestrates sessionless, one-shot workers. Public tool calls may
 * select only runtime-owned named presets and supply their task-content slots.
 * Trusted harness callers retain the separate programmatic script capability.
 * Which slot fields apply depends on `pattern`; unused slots are ignored.
 */
const WorkflowSchema = Type.Object({
	pattern: StringEnum(
		[
			"classify_and_act",
			"fan_out_synthesize",
			"adversarial_verify",
			"generate_and_filter",
			"tournament",
			"loop_until_done",
		] as const,
		{
			description: "Which runtime-owned orchestration preset to run.",
		},
	),
	name: Type.Optional(
		Type.String({ description: "Human-readable name shown in /events. Defaults to the pattern name." }),
	),
	model: Type.Optional(Type.String({ description: "Default model for all workers in this orchestration." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Default tool whitelist for all workers." })),
	packages: Type.Optional(
		Type.Array(Type.String(), { description: "Default Harness package selectors for all workflow workers." }),
	),
	maxConcurrent: Type.Optional(Type.Number({ description: "Max workers running concurrently. Defaults to 8." })),
	// Pattern-specific slots (only the ones matching `pattern` are used):
	classifier: Type.Optional(WorkflowSlotSchema),
	handlers: Type.Optional(Type.Record(Type.String(), WorkflowSlotSchema)),
	fallback: Type.Optional(WorkflowSlotSchema),
	workers: Type.Optional(Type.Array(WorkflowSlotSchema)),
	synthesizer: Type.Optional(WorkflowSlotSchema),
	generator: Type.Optional(WorkflowSlotSchema),
	verifier: Type.Optional(WorkflowSlotSchema),
	evaluator: Type.Optional(WorkflowSlotSchema),
	approaches: Type.Optional(Type.Array(WorkflowSlotSchema)),
	judge: Type.Optional(WorkflowSlotSchema),
	refine: Type.Optional(WorkflowSlotSchema),
	input: Type.Optional(Type.String({ description: "Input payload for classify_and_act." })),
	initial: Type.Optional(Type.String({ description: "Starting content for loop_until_done." })),
	verifyCount: Type.Optional(Type.Number({ description: "Verifier count for adversarial_verify." })),
	threshold: Type.Optional(Type.Number({ description: "Confidence threshold for adversarial_verify." })),
	candidateCount: Type.Optional(Type.Number({ description: "Candidate count for generate_and_filter." })),
	topK: Type.Optional(Type.Number({ description: "How many top candidates to keep for generate_and_filter." })),
	maxIterations: Type.Optional(Type.Number({ description: "Hard iteration cap for loop_until_done." })),
});

export const subAgentSchema = Type.Object(
	{
		action: StringEnum(["start", "status", "cancel"] as const),
		task: Type.Optional(
			Type.String({ description: "Single finite task for action=start; mutually exclusive with workflow." }),
		),
		role: Type.Optional(Type.String({ description: "Optional role hint for the finite worker." })),
		label: Type.Optional(Type.String({ description: "Optional event label." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the finite worker." })),
		tools: Type.Optional(
			Type.Array(Type.String(), { description: "Allowed worker tools; recursive delegation is removed." }),
		),
		packages: Type.Optional(
			Type.Array(Type.String(), { description: "Harness package selectors for the finite worker." }),
		),
		model: Type.Optional(Type.String({ description: "Optional model pattern or provider/model id." })),
		provider: Type.Optional(Type.String({ description: "Optional provider." })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: `Optional hard deadline in seconds for the entire sub-agent or workflow Event, including queued time. Omit for no caller deadline. Maximum ${NODE_MAX_TIMEOUT_SECONDS} seconds.`,
				exclusiveMinimum: 0,
				maximum: NODE_MAX_TIMEOUT_SECONDS,
			}),
		),
		workflow: Type.Optional(WorkflowSchema),
		eventId: Type.Optional(Type.String({ description: "Optional target for status; required for cancel." })),
	},
	{ additionalProperties: false },
);

export type SubAgentInput = Static<typeof subAgentSchema>;
type InternalSubAgentInput = SubAgentInput;
export type SubAgentDetails = Record<string, unknown>;

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function openLogStream(path: string, state: BoundedLogState): Promise<BufferedBoundedLog> {
	const log = createWriteStream(path, { flags: "a", mode: 0o600 });
	log.once("close", () => ACTIVE_SUB_AGENT_ARTIFACTS.delete(resolve(path)));
	// Keep a permanent listener installed so a later filesystem failure cannot
	// become an uncaught EventEmitter "error". Event-specific listeners below
	// still turn such failures into terminal event state.
	log.on("error", () => {});
	return new Promise((resolveOpen, rejectOpen) => {
		const onOpen = () => {
			cleanup();
			resolveOpen(new BufferedBoundedLog(log, { state }));
		};
		const onError = (error: Error) => {
			cleanup();
			rejectOpen(error);
		};
		const cleanup = () => {
			log.off("open", onOpen);
			log.off("error", onError);
		};
		log.once("open", onOpen);
		log.once("error", onError);
	});
}

function normalizePackageSelectors(values: string[] | undefined): string[] {
	return values?.map((selector) => selector.trim()).filter((selector) => selector.length > 0) ?? [];
}

export function sanitizeSubAgentTools(requested: string[] | undefined): string[] {
	const selected = requested?.length ? requested : DEFAULT_TOOLS;
	const tools = selected.filter((name) => !FORBIDDEN_SUB_AGENT_TOOLS.has(name));
	return tools.length ? tools : DEFAULT_TOOLS;
}

function compactValue(value: unknown, maxLength = 1200): string {
	let text: string;
	try {
		const json = typeof value === "string" ? value : JSON.stringify(value);
		text = json ?? String(value);
	} catch {
		text = String(value);
	}
	if (!text) return "";
	text = text.replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function isEventActive(event: SubAgentEvent): boolean {
	return (
		event.status === "queued" ||
		event.status === "starting" ||
		event.status === "running" ||
		event.status === "terminating"
	);
}

function occupiesEventSlot(event: SubAgentEvent): boolean {
	return event.status === "starting" || event.status === "running" || event.status === "terminating";
}

function createOutputDecoders(): Record<SubAgentOutputStream, Utf8TailDecoder> {
	return {
		stdout: new Utf8TailDecoder(),
		stderr: new Utf8TailDecoder(),
		single: new Utf8TailDecoder(),
	};
}

function appendDecodedOutput(event: SubAgentEvent, decoded: string, writeLog: boolean): void {
	if (!decoded) return;
	if (writeLog && event.log) event.log.write(decoded);
	event.tail = appendTailText(event.tail, Buffer.from(decoded, "utf8"));
	if (decoded.trim().length > 0) {
		const now = Date.now();
		event.lastOutputAt = now;
		event.lastActivityAt = now;
	}
}

function appendOutput(event: SubAgentEvent, stream: SubAgentOutputStream, data: Buffer, writeLog = true): void {
	if (!isEventActive(event)) return;
	appendDecodedOutput(event, event.outputDecoders[stream].write(data), writeLog);
}

function flushOutput(event: SubAgentEvent): void {
	for (const decoder of Object.values(event.outputDecoders)) {
		appendDecodedOutput(event, decoder.end(), true);
	}
}

/**
 * Kill a captured target, escalating a process group and falling back to the
 * child handle. Workflow events cancel via their AbortController. Callers
 * capture child/abort before finishEvent() releases event.child so termination
 * still works after the event drops its own pointer.
 */
function killTarget(
	kind: "agent" | "workflow",
	child: ChildProcess | undefined,
	abort: AbortController | undefined,
	signal: NodeJS.Signals,
): void {
	// Workflow events have no single child; cancellation is driven by the AbortController.
	if (kind === "workflow") {
		abort?.abort();
		return;
	}
	const pid = child?.pid;
	if (!pid) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child?.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

/**
 * Request termination without releasing the delegation lease. The event stays
 * active until its child or workflow provider actually settles.
 */
function requestTermination(event: SubAgentEvent, request: TerminationRequest): boolean {
	if (!isEventActive(event) || event.terminationRequest) return false;

	event.log?.flush();
	event.status = "terminating";
	event.terminationRequest = request;
	event.activityPhase = "terminating";
	if (event.timeout !== undefined) clearTimeout(event.timeout);
	event.timeout = undefined;

	const { kind, child, abort } = event;
	if (kind === "agent") {
		const graceKillTimer = setTimeout(() => {
			if (event.graceKillTimer === graceKillTimer) event.graceKillTimer = undefined;
			killTarget(kind, child, abort, "SIGKILL");
		}, TERM_GRACE_MS);
		event.graceKillTimer = graceKillTimer;
		graceKillTimer.unref();
	}
	// Install the escalation timer before signaling: ChildProcess.kill() may emit
	// an "error" synchronously, and termination must still retain its child and
	// lease until the corresponding close event proves the process settled.
	killTarget(kind, child, abort, "SIGTERM");
	return true;
}

function finishEvent(
	event: SubAgentEvent,
	status: AgentStatus,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	error?: string,
): void {
	if (!isEventActive(event)) return;

	flushOutput(event);
	event.status = status;
	event.exitCode = exitCode;
	event.signal = signal;
	event.error = error;
	event.endedAt = Date.now();
	if (event.timeout !== undefined) clearTimeout(event.timeout);
	event.timeout = undefined;
	if (event.graceKillTimer !== undefined) clearTimeout(event.graceKillTimer);
	event.graceKillTimer = undefined;
	event.log?.end();
	// Release live process/cancellation references once terminal so retained
	// events do not pin resources or expose stale cancellation state.
	event.child = undefined;
	event.abort = undefined;
	event.terminationRequest = undefined;

	const waiters = event.waiters.splice(0);
	for (const resolveWaiter of waiters) resolveWaiter();
}

function finishSettledEvent(
	event: SubAgentEvent,
	status: AgentStatus,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	error?: string,
): void {
	const requested = event.terminationRequest;
	finishEvent(event, requested?.status ?? status, exitCode, requested?.signal ?? signal, requested?.error ?? error);
}

function summarizeEvent(
	event: SubAgentEvent,
	includeOutput = true,
	collapsed = false,
	outputLimitBytes = RESULT_LIMIT_BYTES,
): string {
	if (event.kind === "workflow") return summarizeWorkflowEvent(event, includeOutput, collapsed, outputLimitBytes);
	const elapsedUntil = event.endedAt ?? Date.now();
	const output = truncateTail(event.tail.trimEnd(), outputLimitBytes);
	if (collapsed) {
		// Compact form for the chat return: one status line plus an output hint.
		// Full metadata (cwd/tools/model/paths/task) is available on expand.
		const head = `Sub-agent ${event.id}${event.label ? ` (${event.label})` : ""}: ${event.status} (${formatDuration(elapsedUntil - event.startedAt)})`;
		const lines = [head];
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
		`Sub-agent: ${event.id}${event.label ? ` (${event.label})` : ""}`,
		`Status: ${event.status}`,
		`Role: ${event.role ?? "general"}`,
		`CWD: ${event.cwd}`,
		`Tools: ${event.tools.join(",")}`,
		...(event.packages?.length ? [`Packages: ${event.packages.join(",")}`] : []),
		`Model: ${event.model ?? "default"}`,
		`Thinking: ${event.thinking}`,
		`Elapsed: ${formatDuration(elapsedUntil - event.startedAt)}`,
		`Exit code: ${event.exitCode ?? "n/a"}`,
		`Signal: ${event.signal ?? "n/a"}`,
		`Prompt: ${event.promptPath}`,
		`Log: ${event.logPath}`,
		`Task: ${event.task}`,
	];
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

/** Compact chat-return summary (metadata trimmed, output count hidden). */
export function summarizeSubAgentCollapsed(event: SubAgentEventSnapshot): string {
	return summarizeEvent(event as SubAgentEvent, true, true);
}

/** Full summary with all metadata and the captured output tail. */
export function summarizeSubAgentExpanded(event: SubAgentEventSnapshot): string {
	return summarizeEvent(event as SubAgentEvent, true, false, TAIL_LIMIT_BYTES);
}

/** Bounded complete summary sent to the model; eventData retains the expandable tail. */
function summarizeSubAgentForModel(event: SubAgentEvent, maxBytes = MODEL_RESULT_LIMIT_BYTES): string {
	return truncateModelText(summarizeEvent(event, true, false, maxBytes), maxBytes).text;
}

/**
 * Plain-data snapshot of a sub-agent event, safe for structuredClone/postMessage.
 * The live event holds ChildProcess/log-sink/Timer/AbortController references
 * that are not cloneable, so message payloads must carry this snapshot.
 */
export type SubAgentEventSnapshot = Pick<
	SubAgentEvent,
	| "id"
	| "kind"
	| "task"
	| "role"
	| "label"
	| "cwd"
	| "tools"
	| "packages"
	| "model"
	| "provider"
	| "thinking"
	| "promptPath"
	| "logPath"
	| "pattern"
	| "workflowResult"
	| "startedAt"
	| "endedAt"
	| "status"
	| "exitCode"
	| "signal"
	| "error"
	| "tail"
> &
	Partial<Pick<SubAgentEvent, "lastActivityAt" | "lastOutputAt" | "lastProgressAt" | "activityPhase">>;

export function serializableSubAgentSnapshot(event: SubAgentEvent): SubAgentEventSnapshot {
	return {
		id: event.id,
		kind: event.kind,
		task: event.task,
		role: event.role,
		label: event.label,
		cwd: event.cwd,
		tools: event.tools,
		packages: event.packages,
		model: event.model,
		provider: event.provider,
		thinking: event.thinking,
		promptPath: event.promptPath,
		logPath: event.logPath,
		pattern: event.pattern,
		workflowResult: event.workflowResult,
		startedAt: event.startedAt,
		endedAt: event.endedAt,
		status: event.status,
		exitCode: event.exitCode,
		signal: event.signal,
		error: event.error,
		tail: event.tail,
		lastActivityAt: event.lastActivityAt,
		lastOutputAt: event.lastOutputAt,
		lastProgressAt: event.lastProgressAt,
		activityPhase: event.activityPhase,
	};
}

function summarizeWorkflowEvent(
	event: SubAgentEvent,
	includeOutput: boolean,
	collapsed = false,
	outputLimitBytes = RESULT_LIMIT_BYTES,
): string {
	const elapsedUntil = event.endedAt ?? Date.now();
	if (collapsed) {
		const head = `Workflow ${event.id} (${event.label}) [${event.pattern}]: ${event.status} (${formatDuration(elapsedUntil - event.startedAt)})`;
		const lines = [head];
		if (event.error) lines.push(`Error: ${event.error}`);
		if (includeOutput && event.workflowResult) {
			const resultLineCount = formatWorkflowResult(event.workflowResult).split("\n").length;
			lines.push(
				`... ${resultLineCount} result ${resultLineCount === 1 ? "line" : "lines"} hidden (ctrl+o to expand)`,
			);
		} else if (includeOutput) {
			lines.push("(no result yet)");
		}
		return lines.join("\n");
	}
	const lines = [
		`Workflow: ${event.id} (${event.label})`,
		`Pattern: ${event.pattern}`,
		`Status: ${event.status}`,
		`Elapsed: ${formatDuration(elapsedUntil - event.startedAt)}`,
		`Log: ${event.logPath}`,
	];
	if (event.error) lines.push(`Error: ${event.error}`);
	if (includeOutput) {
		if (event.workflowResult) {
			const expanded = outputLimitBytes >= TAIL_LIMIT_BYTES;
			const output = truncateTail(
				formatWorkflowResult(
					event.workflowResult,
					expanded ? TAIL_LIMIT_BYTES : 120,
					expanded ? TAIL_LIMIT_BYTES : 200,
				),
				outputLimitBytes,
			);
			lines.push(
				"",
				"Result:",
				...(output.truncated
					? [`[Result shortened to last ${outputLimitBytes} bytes; full result remains in the log]`]
					: []),
				output.text,
			);
		} else {
			lines.push("", "(no result yet)");
		}
	}
	return lines.join("\n");
}

/**
 * Map the sub_agent `workflow` tool input onto a harness OrchestrationRequest.
 * The worker-slot shapes are aligned by design (WorkflowSlotSchema is a
 * WorkerSlot superset), so those pass through untouched. A few tuning slots are
 * exposed under tool-friendly names that differ from the harness contract keys;
 * those must be remapped explicitly here, otherwise they are silently dropped
 * and the orchestrator falls back to defaults (or, for the required
 * `generate_and_filter` count, breaks candidate generation). The harness
 * validates required slots per pattern and rejects malformed requests.
 */
export function buildOrchestrationRequest(input: WorkflowInput): MultiAgentOrchestrationRequest {
	validateWorkflowTimeouts(input);
	// The harness retains trusted programmatic script workflows, but this facade
	// accepts model-authored tool input. Never turn that input into executable
	// module source in the main process, even if a caller bypasses the schema.
	if ((input as { pattern?: string }).pattern === "script") {
		throw new Error('workflow pattern "script" is not accepted by the sub_agent tool');
	}
	// Tool-only keys that either map to a differently-named contract field
	// (below) or must never pass through from a schema-bypassing caller.
	const {
		name: _name,
		script: _script,
		args: _args,
		scriptPath: _scriptPath,
		threshold,
		candidateCount,
		topK,
		...rest
	} = input as WorkflowInput & {
		script?: unknown;
		args?: unknown;
		scriptPath?: unknown;
	};
	const request = { ...rest } as Record<string, unknown>;
	// adversarial_verify: tool `threshold` -> contract `confidenceThreshold`.
	if (threshold !== undefined) request.confidenceThreshold = threshold;
	// generate_and_filter: tool `candidateCount` -> contract `count` (required),
	// tool `topK` -> contract `keepTop`.
	if (candidateCount !== undefined) request.count = candidateCount;
	if (topK !== undefined) request.keepTop = topK;
	return request as unknown as MultiAgentOrchestrationRequest;
}

function validateWorkflowTimeouts(input: WorkflowInput): void {
	type TimeoutSlot = { timeoutSeconds?: number };
	const validateSlot = (slot: TimeoutSlot | undefined, path: string) => {
		if (slot !== undefined) validateNodeTimeoutSeconds(slot.timeoutSeconds, `${path}.timeoutSeconds`);
	};
	for (const key of [
		"classifier",
		"fallback",
		"synthesizer",
		"generator",
		"verifier",
		"evaluator",
		"judge",
		"refine",
	] as const) {
		validateSlot(input[key], `workflow.${key}`);
	}
	for (const [index, slot] of (input.workers ?? []).entries()) {
		validateSlot(slot, `workflow.workers[${index}]`);
	}
	for (const [index, slot] of (input.approaches ?? []).entries()) {
		validateSlot(slot, `workflow.approaches[${index}]`);
	}
	for (const [key, slot] of Object.entries(input.handlers ?? {})) {
		validateSlot(slot, `workflow.handlers.${key}`);
	}
}

function formatWorkerUsage(usage: WorkerUsage): string {
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost.unknown ? "cost unknown" : `$${usage.cost.total.toFixed(4)}`;
	return `${tokens} tokens (${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache read), ${cost}`;
}

/** Render an OrchestrationResult as a structured tree for /events + returns. */
function formatWorkflowResult(
	result: MultiAgentOrchestrationResult,
	workerTextLimit = 120,
	outcomeTextLimit = 200,
): string {
	const header = [`pattern: ${result.pattern}`, `terminatedBy: ${result.terminatedBy}`];
	if (result.confidence !== undefined) header.push(`confidence: ${result.confidence.toFixed(2)}`);
	if (result.iterations !== undefined) header.push(`iterations: ${result.iterations}`);
	const lines = [header.join(" · ")];
	// Aggregated token/cost usage across all workers, when the harness reported it.
	if (result.usage) {
		const stats = formatWorkerUsage(result.usage);
		if (stats) lines.push(`usage: ${stats}`);
	}
	const workers = result.workers ?? [];
	workers.forEach((w, i) => {
		const branch = i === workers.length - 1 && !result.outcome ? "└─" : "├─";
		const status = w.success ? "ok" : "fail";
		const text = compactValue(w.text ?? w.error ?? "", workerTextLimit) ?? "";
		lines.push(`${branch} ${w.workerId} [${status}] ${text}`);
	});
	if (result.outcome) {
		const o = result.outcome;
		const text = compactValue(o.text ?? o.error ?? "", outcomeTextLimit) ?? "";
		lines.push(`└─ outcome [${o.success ? "ok" : "fail"}] ${text}`);
	}
	return lines.join("\n");
}

function waitForEvent(
	event: SubAgentEvent,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
): Promise<"done" | "timeout" | "aborted"> {
	if (!isEventActive(event)) return Promise.resolve("done");
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

function writePrivateFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export class SubAgentController {
	private nextAgentNumber = 1;
	private shuttingDown = false;
	private shutdownGeneration = 0;
	private events = new Map<string, SubAgentEvent>();
	private pendingStarts = new Map<string, PendingStart>();
	private startQueue: string[] = [];
	private maxRetainedFinishedEvents = MAX_RETAINED_FINISHED_EVENTS;
	private mainToolProgress = new Map<string, MainToolProgress>();
	private readonly workDirRoot: string;
	private readonly workDir: string;
	private readonly mainProgressPath: string;
	private readonly progressWriteIntervalMs: number;
	private readonly progressWriter: (path: string, content: string) => void;
	private progressWriteTimer?: NodeJS.Timeout;
	private pendingProgressSnapshot?: string;
	private lastProgressWriteAt = 0;
	private config: SubAgentConfig = {
		defaultReturnDelivery: "followUp",
		defaultThinking: DEFAULT_THINKING,
	};
	private monitor: { update: () => void; dispose?: () => void };
	private registerReturn: SubAgentRegisterReturn;
	private cancelReturn: SubAgentCancelReturn;
	private spawnAgent: SubAgentSpawn;
	private resolveAgentInvocation: SubAgentInvocationResolver;
	private readonly defaultCwd: string;
	private getDefaultModel?: () => SubAgentModelSelection | undefined;
	private getWorkflowProvider?: () => SubAgentWorkflowProvider | undefined;
	private isWorkflowEnabled: () => boolean;

	constructor(
		manager: BackgroundEventManagerPort,
		options: {
			registerReturn: SubAgentRegisterReturn;
			cancelReturn: SubAgentCancelReturn;
			spawnAgent?: SubAgentSpawn;
			/** Explicit command override retained for embedders and tests. */
			agentCommand?: string;
			resolveAgentInvocation?: SubAgentInvocationResolver;
			cwd?: string;
			getDefaultModel?: () => SubAgentModelSelection | undefined;
			getWorkflowProvider?: () => SubAgentWorkflowProvider | undefined;
			isWorkflowEnabled?: () => boolean;
			/** Host-owned finite Event policy. */
			defaultTimeoutSeconds?: number;
			defaultReturnDelivery?: ReturnDelivery;
			defaultThinking?: ThinkingLevel;
			/** Override the finished-event retention cap (primarily for tests). */
			maxRetainedFinishedEvents?: number;
			/** Override the namespace root (primarily for embedders and tests). */
			workDirRoot?: string;
			/** Override progress coalescing and persistence for focused tests. */
			progressWriteIntervalMs?: number;
			progressWriter?: (path: string, content: string) => void;
		},
	) {
		const controllerToken = `${process.pid}-${randomUUID()}`;
		this.defaultCwd = options.cwd ?? process.cwd();
		this.workDirRoot = options.workDirRoot ?? WORK_DIR_ROOT;
		this.workDir = join(this.workDirRoot, controllerToken);
		this.mainProgressPath = join(this.workDir, "main-tool-progress.md");
		ACTIVE_SUB_AGENT_ARTIFACTS.add(resolve(this.mainProgressPath));
		this.progressWriteIntervalMs =
			typeof options.progressWriteIntervalMs === "number" &&
			Number.isFinite(options.progressWriteIntervalMs) &&
			options.progressWriteIntervalMs >= 0
				? options.progressWriteIntervalMs
				: MAIN_PROGRESS_WRITE_INTERVAL_MS;
		this.progressWriter = options.progressWriter ?? writePrivateFileAtomic;
		this.registerReturn = options.registerReturn;
		this.cancelReturn = options.cancelReturn;
		this.spawnAgent = options.spawnAgent ?? spawn;
		this.resolveAgentInvocation = options.agentCommand
			? (args) => ({ command: options.agentCommand!, args })
			: (options.resolveAgentInvocation ??
				(() => {
					throw new Error("sub_agent requires resolveAgentInvocation");
				}));
		this.getDefaultModel = options.getDefaultModel;
		this.getWorkflowProvider = options.getWorkflowProvider;
		this.isWorkflowEnabled = options.isWorkflowEnabled ?? (() => true);
		this.config = {
			defaultTimeoutSeconds: validateNodeTimeoutSeconds(options.defaultTimeoutSeconds, "defaultTimeoutSeconds"),
			defaultReturnDelivery: options.defaultReturnDelivery ?? "followUp",
			defaultThinking: options.defaultThinking ?? DEFAULT_THINKING,
		};
		if (options.maxRetainedFinishedEvents !== undefined && options.maxRetainedFinishedEvents >= 0) {
			this.maxRetainedFinishedEvents = options.maxRetainedFinishedEvents;
		}
		this.monitor = manager.registerSource({
			id: "agents",
			title: "agents",
			getEvents: () =>
				[...this.events.values()].map((event) => ({
					id: event.id,
					status: event.status,
					startedAt: event.startedAt,
					endedAt: event.endedAt,
					label: event.label ?? event.role ?? event.task,
					cwd: event.cwd,
					logPath: event.logPath,
					tail: event.tail,
					lastActivityAt: event.lastActivityAt,
					lastOutputAt: event.lastOutputAt,
					lastProgressAt: event.lastProgressAt,
					activityPhase: event.activityPhase,
					reminderEligible: event.status === "running",
					canCancel: isEventActive(event),
				})),
			getEventDetails: (id) => {
				const event = this.events.get(id);
				if (!event) return [`unknown agent event: ${id}`];
				if (event.kind === "workflow") {
					// Expanding a workflow event reveals its internal structure: the
					// pattern, and each worker the orchestration ran (the (b)/(c) case).
					const head = [
						`pattern: ${event.pattern}`,
						`cwd: ${event.cwd}`,
						`log: ${event.logPath}`,
						...(event.error ? [`error: ${event.error}`] : []),
					];
					if (event.workflowResult) head.push(...formatWorkflowResult(event.workflowResult).split("\n"));
					else head.push("(running...)");
					return head;
				}
				return [
					`role: ${event.role ?? "general"}`,
					`cwd: ${event.cwd}`,
					`tools: ${event.tools.join(",")}`,
					...(event.packages?.length ? [`packages: ${event.packages.join(",")}`] : []),
					`model: ${event.model ?? "default"}`,
					`thinking: ${event.thinking}`,
					`prompt: ${event.promptPath}`,
					`log: ${event.logPath}`,
					`exit: ${event.exitCode ?? "n/a"}`,
					`signal: ${event.signal ?? "n/a"}`,
					...(event.error ? [`error: ${event.error}`] : []),
				];
			},
			cancelEvent: (id) => this.cancelEvent(id),
		});
	}

	private async cleanupArtifacts(): Promise<void> {
		const protectedPrefixes: string[] = [];
		try {
			const entries = await readdir(this.workDirRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
				const pid = Number.parseInt(entry.name.split("-", 1)[0] ?? "", 10);
				if (pid !== process.pid && isProcessAlive(pid)) protectedPrefixes.push(join(this.workDirRoot, entry.name));
			}
		} catch {
			// The root is created lazily when the first worker starts.
		}
		await cleanupLogTree({
			root: this.workDirRoot,
			fileFilter: (path) => {
				const name = basename(path);
				return name.endsWith(".log") || name.endsWith(".prompt.md") || name === "main-tool-progress.md";
			},
			protectedPaths: ACTIVE_SUB_AGENT_ARTIFACTS,
			protectedPrefixes,
			emptyDirectoryFilter: (path) => {
				const parent = resolve(path, "..");
				return parent === resolve(this.workDirRoot) && /^\d+-[0-9a-f-]+$/i.test(basename(path));
			},
			maxAgeMs: DEFAULT_LOG_MAX_AGE_MS,
			maxTotalBytes: DEFAULT_LOG_MAX_TOTAL_BYTES,
			maxFiles: DEFAULT_LOG_MAX_FILES,
		});
	}

	createToolDefinition(): AgentTool<any, SubAgentDetails> {
		const controller = this;
		return {
			name: "sub_agent",
			label: "Sub Agent",
			get description() {
				return controller.isWorkflowEnabled()
					? `Register, inspect, or cancel one finite Event backed by a sessionless ${APP_NAME} worker or one trusted Workflow. action=start accepts exactly one task or one workflow; independent parallelism uses independent Tool calls. Workflow control flow is runtime-owned. Workers inherit the parent model unless overridden, run with --no-session --no-extensions, and receive parent progress.`
					: `Register, inspect, or cancel one finite Event backed by a sessionless ${APP_NAME} worker. action=start accepts exactly one task. Independent parallelism uses independent Tool calls. Workers inherit the parent model unless overridden, run with --no-session --no-extensions, and receive parent progress.`;
			},
			promptSnippet: "Register one sessionless finite Event for bounded delegation",
			get promptGuidelines() {
				return [
					"Use sub_agent for bounded one-shot work. Use multiagent when retained context, repeated prompts, or explicit worktree ownership is required.",
					"Each start call registers one Event and returns immediately. Use independent concurrent Tool calls for independent tasks.",
					"A successful start creates a soft lease on its scope. Continue only non-overlapping work until its terminal external activation arrives.",
					`Each caller Session runs at most ${MAX_START_MANY} top-level Events at once; valid excess Events queue FIFO.`,
					"Workers are sessionless and cannot recursively delegate.",
					...(controller.isWorkflowEnabled()
						? [
								"Use only the six runtime-owned Workflow presets; each Workflow independently caps internal worker concurrency at eight.",
							]
						: []),
				];
			},
			get parameters() {
				return controller.isWorkflowEnabled() ? subAgentSchema : Type.Omit(subAgentSchema, ["workflow"]);
			},
			renderKind: "sub-agent-result",
			execute: (_toolCallId, params, signal) =>
				controller.execute(params as SubAgentInput, signal, { cwd: controller.defaultCwd }),
		} as AgentTool<any, SubAgentDetails>;
	}

	handleAgentEvent(event: AgentSessionEvent): void {
		if (this.shuttingDown) return;
		if (event.type === "agent_start") {
			this.mainToolProgress.clear();
			this.scheduleMainProgressSnapshot(true);
			return;
		}
		if (event.type === "tool_execution_start") {
			const now = Date.now();
			this.mainToolProgress.set(event.toolCallId, {
				id: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				status: "running",
				startedAt: now,
				updatedAt: now,
			});
			this.pruneMainToolProgress();
			this.scheduleMainProgressSnapshot(true);
			return;
		}
		if (event.type === "tool_execution_update") {
			const existing = this.mainToolProgress.get(event.toolCallId);
			if (!existing) {
				const now = Date.now();
				this.mainToolProgress.set(event.toolCallId, {
					id: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
					status: "running",
					startedAt: now,
					updatedAt: now,
				});
				this.scheduleMainProgressSnapshot();
				return;
			}
			existing.args = event.args ?? existing.args;
			existing.partialResult = event.partialResult;
			existing.updatedAt = Date.now();
			this.scheduleMainProgressSnapshot();
			return;
		}
		if (event.type === "tool_execution_end") {
			const existing = this.mainToolProgress.get(event.toolCallId);
			const now = Date.now();
			this.mainToolProgress.set(event.toolCallId, {
				id: event.toolCallId,
				toolName: event.toolName,
				args: existing?.args,
				partialResult: existing?.partialResult,
				result: event.result,
				isError: event.isError,
				status: "finished",
				startedAt: existing?.startedAt ?? now,
				updatedAt: now,
				endedAt: now,
			});
			this.pruneMainToolProgress();
			this.scheduleMainProgressSnapshot(true);
		}
	}

	hasLiveWork(): boolean {
		return [...this.events.values()].some((event) => isEventActive(event));
	}

	shutdown(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.flushMainProgressSnapshot(false);
		this.shutdownGeneration += 1;
		for (const event of this.events.values()) {
			if (!isEventActive(event)) continue;
			if (event.autoReturnPending) {
				event.autoReturnPending = false;
				this.cancelReturn([event.id]);
			}
			if (event.status === "queued" || (event.status === "starting" && !event.child && !event.abort)) {
				finishEvent(event, "cancelled", null, null, "Cancelled by session shutdown");
				this.onEventTerminal(event);
			} else {
				requestTermination(event, {
					status: "cancelled",
					error: "Cancelled by session shutdown",
					signal: "SIGTERM",
				});
			}
		}
		this.startQueue.length = 0;
		this.releaseControllerArtifactsIfInactive();
		this.monitor.update();
		this.monitor.dispose?.();
	}

	private assertStartAllowed(signal: AbortSignal | undefined, generation = this.shutdownGeneration): void {
		if (signal?.aborted) throw new Error("sub_agent start was aborted");
		if (this.shuttingDown || generation !== this.shutdownGeneration) {
			throw new Error("sub_agent controller is shutting down or interrupted the start");
		}
	}

	private assertEventStarting(event: SubAgentEvent): void {
		if (event.status !== "starting") {
			throw new Error(`sub_agent event ${event.id} is no longer starting`);
		}
	}

	private async execute(params: SubAgentInput, signal: AbortSignal | undefined, ctx: HostToolContext) {
		const action = params.action as Action;
		if (action === "start") {
			const hasTask = Boolean(params.task?.trim());
			const hasWorkflow = params.workflow !== undefined;
			if (hasTask === hasWorkflow) {
				throw new ToolExecutionError(
					"invalid_arguments",
					"sub_agent action=start requires exactly one of task or workflow",
				);
			}
			return this.start(
				params as InternalSubAgentInput,
				signal,
				ctx,
				true,
				this.config.defaultReturnDelivery,
				undefined,
			);
		}
		if (action === "status") return this.status(params);
		if (action === "cancel") {
			if (!params.eventId?.trim()) {
				throw new ToolExecutionError("invalid_arguments", "sub_agent action=cancel requires eventId");
			}
			return this.cancel(params);
		}
		throw new Error(`Unsupported sub_agent action: ${String(action)}`);
	}

	private async start(
		params: InternalSubAgentInput,
		signal: AbortSignal | undefined,
		ctx: HostToolContext,
		_returnToMain: boolean,
		returnDelivery: ReturnDelivery,
		returnInstruction: string | undefined,
	) {
		this.assertStartAllowed(signal);
		const explicitTimeoutSeconds = validateNodeTimeoutSeconds(params.timeoutSeconds, "timeoutSeconds");
		if (params.workflow) buildOrchestrationRequest(params.workflow);
		if (params.workflow && !this.isWorkflowEnabled()) {
			throw new ToolExecutionError(
				"unauthorized",
				"sub_agent workflows are disabled for the current execution profile",
			);
		}
		if (params.workflow && !this.getWorkflowProvider?.()) {
			throw new ToolExecutionError("invalid_state", "sub_agent workflow runtime is unavailable");
		}

		const id = `agent_${String(this.nextAgentNumber++).padStart(3, "0")}`;
		const queuedAt = Date.now();
		const stamp = timestampForFile();
		const isWorkflow = params.workflow !== undefined;
		const cwd = resolve(ctx.cwd, params.cwd ?? ".");
		const tools = isWorkflow ? (params.workflow?.tools ?? []) : sanitizeSubAgentTools(params.tools);
		const packages = normalizePackageSelectors(params.workflow?.packages ?? params.packages);
		const label = isWorkflow ? params.workflow?.name?.trim() || params.workflow!.pattern : params.label;
		const logPath = join(this.workDir, `${id}-${stamp}${isWorkflow ? ".workflow" : ""}.log`);
		const promptPath = isWorkflow ? logPath : join(this.workDir, `${id}-${stamp}.prompt.md`);
		const event: SubAgentEvent = {
			id,
			kind: isWorkflow ? "workflow" : "agent",
			task: isWorkflow ? label! : params.task!,
			role: params.role,
			label,
			pattern: params.workflow?.pattern,
			cwd,
			tools,
			packages,
			model: params.workflow?.model ?? params.model,
			provider: params.provider,
			thinking: (params.thinking ?? this.config.defaultThinking) as ThinkingLevel,
			promptPath,
			logPath,
			log: null,
			logState: createBoundedLogState(),
			queuedAt,
			startedAt: queuedAt,
			status: "queued",
			exitCode: null,
			signal: null,
			tail: "",
			outputDecoders: createOutputDecoders(),
			lastActivityAt: queuedAt,
			activityPhase: "queued",
			waiters: [],
		};
		const timeoutSeconds = explicitTimeoutSeconds ?? this.config.defaultTimeoutSeconds;
		const timeoutMs = nodeTimeoutSecondsToMs(timeoutSeconds, "timeoutSeconds");
		const deadlineAt = timeoutMs === undefined ? undefined : queuedAt + timeoutMs;
		if (deadlineAt !== undefined) {
			event.timeout = setTimeout(() => this.timeoutEvent(id, timeoutSeconds!), timeoutMs!);
			event.timeout.unref?.();
		}
		this.events.set(id, event);
		ACTIVE_SUB_AGENT_ARTIFACTS.add(resolve(event.logPath));
		ACTIVE_SUB_AGENT_ARTIFACTS.add(resolve(event.promptPath));
		this.pendingStarts.set(id, {
			eventId: id,
			parentCwd: ctx.cwd,
			task: isWorkflow ? undefined : (params as AgentTask),
			workflow: params.workflow,
			deadlineAt,
		});
		this.startQueue.push(id);
		this.scheduleReturnToMain([event], returnDelivery, returnInstruction);
		this.monitor.update();
		queueMicrotask(() => this.pumpStartQueue());

		const active = [...this.events.values()].filter(occupiesEventSlot).length;
		const queued = this.startQueue.length;
		return {
			content: [{ type: "text" as const, text: `Accepted sub-agent event ${id} in queued state.` }],
			details: {
				schemaVersion: 1,
				action: "start",
				eventId: id,
				state: "queued",
				queuedAt: new Date(queuedAt).toISOString(),
				capacity: { active, limit: MAX_START_MANY, queued },
			},
		};
	}

	private timeoutEvent(id: string, timeoutSeconds: number): void {
		const event = this.events.get(id);
		if (!event || !isEventActive(event)) return;
		if (event.status === "queued" || (event.status === "starting" && !event.child && !event.abort)) {
			finishEvent(event, "timed_out", null, null, `Timed out after ${timeoutSeconds}s`);
			this.onEventTerminal(event);
		} else {
			requestTermination(event, {
				status: "timed_out",
				error: `Timed out after ${timeoutSeconds}s`,
				signal: "SIGTERM",
			});
		}
		this.monitor.update();
	}

	private pumpStartQueue(): void {
		if (this.shuttingDown) return;
		while ([...this.events.values()].filter(occupiesEventSlot).length < MAX_START_MANY) {
			const id = this.startQueue.shift();
			if (!id) return;
			const event = this.events.get(id);
			const pending = this.pendingStarts.get(id);
			if (!event || !pending || event.status !== "queued") continue;
			if (pending.deadlineAt !== undefined && pending.deadlineAt <= Date.now()) {
				this.timeoutEvent(id, Math.max(0, (pending.deadlineAt - event.queuedAt) / 1000));
				continue;
			}
			event.status = "starting";
			event.activityPhase = "starting";
			event.lastActivityAt = Date.now();
			void this.launchPendingStart(pending, event);
		}
		this.monitor.update();
	}

	private async launchPendingStart(pending: PendingStart, event: SubAgentEvent): Promise<void> {
		try {
			if (pending.workflow) {
				await this.startWorkflow(
					pending.workflow,
					pending.parentCwd,
					undefined,
					undefined,
					() => {},
					this.shutdownGeneration,
					event,
				);
			} else {
				await this.startSubAgent(
					pending.task!,
					pending.parentCwd,
					undefined,
					() => {},
					this.shutdownGeneration,
					event,
				);
			}
			this.pendingStarts.delete(event.id);
		} catch (error) {
			if (isEventActive(event)) {
				finishSettledEvent(event, "failed", null, null, error instanceof Error ? error.message : String(error));
				this.onEventTerminal(event);
			}
		}
		this.monitor.update();
	}

	private onEventTerminal(event: SubAgentEvent): void {
		// Open logs stay protected until WriteStream close proves every queued write
		// reached the descriptor. Paths that never opened have no close callback.
		const logPath = resolve(event.logPath);
		const promptPath = resolve(event.promptPath);
		if (!event.log) ACTIVE_SUB_AGENT_ARTIFACTS.delete(logPath);
		// Workflow events intentionally reuse the log path as their prompt path.
		// In that case only the stream's close callback may release protection.
		if (promptPath !== logPath) ACTIVE_SUB_AGENT_ARTIFACTS.delete(promptPath);
		this.pendingStarts.delete(event.id);
		const queueIndex = this.startQueue.indexOf(event.id);
		if (queueIndex >= 0) this.startQueue.splice(queueIndex, 1);
		this.pruneFinishedEvents();
		this.releaseControllerArtifactsIfInactive();
		queueMicrotask(() => this.pumpStartQueue());
	}

	private releaseControllerArtifactsIfInactive(): void {
		if (!this.shuttingDown || this.hasLiveWork()) return;
		ACTIVE_SUB_AGENT_ARTIFACTS.delete(resolve(this.mainProgressPath));
	}

	private status(params: SubAgentInput) {
		const targeted = params.eventId ? this.events.get(params.eventId) : undefined;
		if (params.eventId && !targeted) {
			throw new ToolExecutionError("not_found", `Unknown sub-agent event: ${params.eventId}`, {
				target: params.eventId,
			});
		}
		const selected = targeted
			? [targeted]
			: [...this.events.values()].sort((left, right) => {
					const activeOrder = Number(isEventActive(right)) - Number(isEventActive(left));
					if (activeOrder !== 0) return activeOrder;
					const registrationOrder = right.queuedAt - left.queuedAt;
					return registrationOrder !== 0 ? registrationOrder : right.id.localeCompare(left.id);
				});
		const summaries = selected.map((event) =>
			params.eventId ? summarizeSubAgentForModel(event) : summarizeEvent(event, false),
		);
		const text = summaries.length ? summaries.join("\n\n---\n\n") : "No sub-agents.";
		const content = truncateModelText(text, MODEL_RESULT_TOTAL_LIMIT_BYTES).text;
		return {
			content: [{ type: "text" as const, text: content }],
			details: {
				schemaVersion: 1,
				action: "status",
				events: selected.map((event) => ({
					eventId: event.id,
					state: event.status,
					kind: event.kind,
					queuedAt: new Date(event.queuedAt).toISOString(),
					runningAt: event.runningAt ? new Date(event.runningAt).toISOString() : undefined,
					endedAt: event.endedAt ? new Date(event.endedAt).toISOString() : undefined,
					queuePosition: event.status === "queued" ? this.startQueue.indexOf(event.id) + 1 : undefined,
					error: event.error,
				})),
				capacity: {
					active: [...this.events.values()].filter(occupiesEventSlot).length,
					limit: MAX_START_MANY,
					queued: this.startQueue.length,
				},
				policy: {
					defaultTimeoutSeconds: this.config.defaultTimeoutSeconds,
					defaultThinking: this.config.defaultThinking,
					returnDelivery: this.config.defaultReturnDelivery,
					maxRetainedTerminalEvents: this.maxRetainedFinishedEvents,
				},
			},
		};
	}

	private cancel(params: SubAgentInput) {
		const id = params.eventId!;
		const event = this.events.get(id);
		if (!event) throw new ToolExecutionError("not_found", `Unknown sub-agent event: ${id}`, { target: id });
		if (!isEventActive(event) || event.status === "terminating") {
			throw new ToolExecutionError("invalid_state", `Sub-agent event ${id} is already ${event.status}`, {
				target: id,
				currentState: event.status,
			});
		}
		this.cancelEvent(id);
		const text =
			event.status === "cancelled"
				? `Cancelled queued sub-agent event ${id}.`
				: `Cancellation accepted for sub-agent event ${id}.`;
		return {
			content: [{ type: "text" as const, text }],
			details: { schemaVersion: 1, action: "cancel", eventId: id, state: event.status },
		};
	}

	private async startSubAgent(
		input: AgentTask,
		_parentCwd: string,
		signal: AbortSignal | undefined,
		_consumeReservation: () => void,
		startGeneration: number,
		event?: SubAgentEvent,
	): Promise<SubAgentEvent> {
		if (!event) throw new Error("sub_agent internal event registration is required");
		await this.cleanupArtifacts();
		await mkdir(this.workDir, { recursive: true, mode: 0o700 });
		this.assertStartAllowed(signal, startGeneration);
		this.assertEventStarting(event);

		const { cwd, promptPath, logPath } = event;
		const tools = event.tools;
		const packages = event.packages ?? [];
		const thinking = event.thinking;
		this.pendingProgressSnapshot = `${this.formatMainToolProgress()}\n`;
		this.flushMainProgressSnapshot(true);
		this.assertStartAllowed(signal, startGeneration);
		this.assertEventStarting(event);
		const prompt = this.buildPrompt(input, cwd, tools);
		await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		this.assertStartAllowed(signal, startGeneration);
		this.assertEventStarting(event);

		const args = ["--print", "--no-session", "--no-extensions", "--tools", tools.join(","), "--thinking", thinking];
		// Packages are independent of extensions: --no-extensions above still stands,
		// but the parent may grant specific harness packages to the sub-agent.
		for (const selector of packages) args.push("--harness-package", selector);
		const inheritDefaultModel = !input.provider && (!input.model || input.model.trim().toLowerCase() === "default");
		const inheritedModel = inheritDefaultModel ? this.getDefaultModel?.() : undefined;
		const provider = input.provider ?? inheritedModel?.provider;
		const model = inheritDefaultModel ? inheritedModel?.model : input.model;
		if (provider) args.push("--provider", provider);
		if (model) args.push("--model", model);
		args.push(`@${promptPath}`);

		const log = await openLogStream(logPath, event.logState);
		event.log = log;
		try {
			this.assertStartAllowed(signal, startGeneration);
			this.assertEventStarting(event);
		} catch (error) {
			log.end();
			throw error;
		}
		const invocation = this.resolveAgentInvocation(args);
		let child: ChildProcess | undefined;
		try {
			child = this.spawnAgent(invocation.command, invocation.args, {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUB_AGENT: "1" },
			});
			event.child = child;
			if (event.status !== "starting") throw new Error(`sub_agent event ${event.id} was cancelled while starting`);
			this.assertStartAllowed(signal, startGeneration);
		} catch (error) {
			if (child) killTarget("agent", child, undefined, "SIGTERM");
			log.end();
			throw error;
		}

		const runningAt = Date.now();
		event.model = model;
		event.provider = provider;
		event.child = child;
		event.runningAt = runningAt;
		event.status = "running";
		event.lastActivityAt = runningAt;
		event.activityPhase = "agent";
		this.monitor.update();

		log.onError((error) => {
			if (!isEventActive(event)) return;
			requestTermination(event, {
				status: "failed",
				error: `Log stream failed: ${error.message}`,
				signal: "SIGTERM",
			});
			this.monitor.update();
		});
		log.write(`$ ${invocation.command} ${invocation.args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
		child.stdout?.on("data", (data: Buffer) => {
			appendOutput(event, "stdout", data);
			this.monitor.update();
		});
		child.stderr?.on("data", (data: Buffer) => {
			appendOutput(event, "stderr", data);
			this.monitor.update();
		});
		child.on("error", (error) => {
			// A pid-bearing child can emit "error" when a termination signal fails.
			// Its close event remains the authority for process settlement. Spawn
			// errors have no pid and preserve the existing immediate failure path.
			if (event.status === "terminating" && child.pid) return;
			finishSettledEvent(event, "failed", null, null, error.message);
			this.onEventTerminal(event);
			this.monitor.update();
		});
		child.on("close", (code, closeSignal) => {
			finishSettledEvent(event, code === 0 ? "exited" : "failed", code, closeSignal);
			this.onEventTerminal(event);
			this.monitor.update();
		});

		return event;
	}

	private async startWorkflow(
		input: WorkflowInput,
		_parentCwd: string,
		signal: AbortSignal | undefined,
		_timeoutSeconds: number | undefined,
		_consumeReservation: () => void,
		startGeneration: number,
		event?: SubAgentEvent,
	): Promise<SubAgentEvent> {
		if (!event) throw new Error("sub_agent internal workflow event registration is required");
		const provider = this.getWorkflowProvider?.();
		if (!provider) {
			throw new Error("Multi-agent workflow capability is unavailable from the session HCP");
		}
		const { cwd, logPath } = event;
		const request = { ...buildOrchestrationRequest(input), cwd } as MultiAgentOrchestrationRequest;
		await this.cleanupArtifacts();
		await mkdir(this.workDir, { recursive: true, mode: 0o700 });
		this.assertStartAllowed(signal, startGeneration);
		this.assertEventStarting(event);

		const abort = new AbortController();
		event.abort = abort;
		const log = await openLogStream(logPath, event.logState);
		event.log = log;
		try {
			this.assertStartAllowed(signal, startGeneration);
			this.assertEventStarting(event);
		} catch (error) {
			log.end();
			throw error;
		}

		if (event.status !== "starting") {
			log.end();
			throw new Error(`sub_agent event ${event.id} was cancelled while starting`);
		}
		const runningAt = Date.now();
		event.abort = abort;
		event.runningAt = runningAt;
		event.status = "running";
		event.lastActivityAt = runningAt;
		event.activityPhase = `workflow:${input.pattern}`;
		this.monitor.update();

		log.onError((error) => {
			if (!isEventActive(event)) return;
			requestTermination(event, {
				status: "failed",
				error: `Log stream failed: ${error.message}`,
				signal: "SIGTERM",
			});
			this.monitor.update();
		});
		log.write(`# workflow ${input.pattern}${input.name ? ` (${input.name})` : ""}\n\n`);

		void Promise.resolve()
			.then(() => provider.orchestrate(request, abort.signal))
			.then((result) => {
				if (!isEventActive(event)) return;
				event.workflowResult = result;
				const summary = formatWorkflowResult(result);
				appendOutput(event, "single", Buffer.from(`${summary}\n`), false);
				let completeResult: string;
				try {
					completeResult = JSON.stringify(result, null, 2);
				} catch {
					completeResult = summary;
				}
				log.write(`${completeResult}\n`);
				const overallFailed = (result as MultiAgentOrchestrationResult & { success?: boolean }).success === false;
				const outcomeFailed = result.outcome?.success === false;
				const budgetFailed = result.terminatedBy === "budget";
				const failed = overallFailed || outcomeFailed || budgetFailed;
				const error = failed
					? (result.outcome?.error ?? `Workflow reported failure (terminatedBy=${result.terminatedBy})`)
					: undefined;
				finishSettledEvent(event, failed ? "failed" : "exited", failed ? null : 0, null, error);
				this.onEventTerminal(event);
				this.monitor.update();
			})
			.catch((error: unknown) => {
				if (!isEventActive(event)) return;
				const message = error instanceof Error ? error.message : String(error);
				const aborted = abort.signal.aborted;
				finishSettledEvent(event, aborted ? "cancelled" : "failed", null, aborted ? "SIGTERM" : null, message);
				this.onEventTerminal(event);
				this.monitor.update();
			});

		return event;
	}

	private cancelEvent(id: string): boolean {
		const event = this.events.get(id);
		if (!event || !isEventActive(event) || event.status === "terminating") return false;
		let requested: boolean;
		if (event.status === "queued" || (event.status === "starting" && !event.child && !event.abort)) {
			finishEvent(event, "cancelled", null, null, "Cancelled before worker start");
			this.onEventTerminal(event);
			requested = true;
		} else {
			requested = requestTermination(event, {
				status: "cancelled",
				error: "Cancelled by background events UI",
				signal: "SIGTERM",
			});
		}
		this.monitor.update();
		return requested;
	}

	/**
	 * Bound the events Map: keep every running event (and anything still awaited),
	 * plus the most recent finished events up to MAX_RETAINED_FINISHED_EVENTS.
	 * Finished events are evicted oldest-first by endedAt so a long session that
	 * spawns many sub-agents/workflows cannot grow the Map without bound.
	 */
	private pruneFinishedEvents(): void {
		const finished = [...this.events.values()].filter(
			(event) => !isEventActive(event) && event.waiters.length === 0 && !event.autoReturnPending,
		);
		if (finished.length <= this.maxRetainedFinishedEvents) return;
		finished.sort((a, b) => {
			const registrationOrder = a.queuedAt - b.queuedAt;
			return registrationOrder !== 0 ? registrationOrder : a.id.localeCompare(b.id);
		});
		for (const event of finished.slice(0, finished.length - this.maxRetainedFinishedEvents)) {
			this.events.delete(event.id);
		}
	}

	private returnSubAgentResultToMain(event: SubAgentEvent, delivery: ReturnDelivery, instruction?: string): void {
		if (this.shuttingDown || !event.autoReturnPending) return;

		const defaultInstruction =
			"Sub-agent work is terminal and its soft lease is released. Synthesize these results, independently verify them, and continue the original task. Do not ask the user to manually inspect event ids unless more information is needed.";
		const resolvedInstruction = instruction?.trim() || defaultInstruction;
		const boundedInstruction = truncateModelText(resolvedInstruction, MODEL_RESULT_LIMIT_BYTES).text;
		const separatorBytes = Buffer.byteLength("\n\n", "utf8");
		const summaryBudget = Math.max(
			1024,
			MODEL_RESULT_TOTAL_LIMIT_BYTES - Buffer.byteLength(boundedInstruction, "utf8") - separatorBytes,
		);
		const summary = summarizeSubAgentForModel(event, Math.min(MODEL_RESULT_LIMIT_BYTES, summaryBudget));
		const content = truncateModelText(`${boundedInstruction}\n\n${summary}`, MODEL_RESULT_TOTAL_LIMIT_BYTES).text;

		// Each event owns one independently cancellable coordinator record. The
		// coordinator can still debounce several records into one continuation turn.
		this.registerReturn(
			[event.id],
			{
				customType: "sub-agent-return",
				content,
				display: true,
				details: {
					ids: [event.id],
					statuses: [event.status],
					instruction: boundedInstruction,
					eventData: [serializableSubAgentSnapshot(event)],
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

	private scheduleReturnToMain(
		completedEvents: SubAgentEvent[],
		delivery: ReturnDelivery,
		instruction?: string,
	): void {
		for (const event of completedEvents) {
			event.autoReturnPending = true;
			void (async () => {
				await waitForEvent(event, undefined, undefined);
				// Let an internal compatibility consumer clear this event's record first.
				await Promise.resolve();
				this.returnSubAgentResultToMain(event, delivery, instruction);
			})().catch(() => undefined);
		}
	}

	private formatMainToolProgress(): string {
		const entries = [...this.mainToolProgress.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-30);
		const lines = ["# Parent main-agent tool progress", "", `Updated: ${new Date().toISOString()}`, ""];
		if (!entries.length) {
			lines.push("No main-agent tool executions have been observed yet.");
			return lines.join("\n");
		}

		const now = Date.now();
		for (const entry of entries) {
			const elapsed = Math.max(0, Math.round(((entry.endedAt ?? now) - entry.startedAt) / 1000));
			lines.push(
				`- ${entry.toolName} (${entry.status}${entry.isError ? ", error" : ""}, ${elapsed}s, id=${entry.id})`,
			);
			const args = compactValue(entry.args, 700);
			if (args) lines.push(`  - args: ${args}`);
			const partial = compactValue(entry.partialResult, 900);
			if (entry.status === "running" && partial) lines.push(`  - latest update: ${partial}`);
			const result = compactValue(entry.result, 900);
			if (entry.status === "finished" && result) lines.push(`  - result: ${result}`);
		}
		return lines.join("\n");
	}

	private pruneMainToolProgress(): void {
		const entries = [...this.mainToolProgress.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		for (const entry of entries.slice(60)) this.mainToolProgress.delete(entry.id);
	}

	private scheduleMainProgressSnapshot(immediate = false): void {
		this.pendingProgressSnapshot = `${this.formatMainToolProgress()}\n`;
		if (immediate) {
			this.flushMainProgressSnapshot(false);
			return;
		}
		const delay = this.progressWriteIntervalMs - (Date.now() - this.lastProgressWriteAt);
		if (delay <= 0) {
			this.flushMainProgressSnapshot(false);
			return;
		}
		if (this.progressWriteTimer) return;
		this.progressWriteTimer = setTimeout(() => {
			this.progressWriteTimer = undefined;
			this.flushMainProgressSnapshot(false);
		}, delay);
		this.progressWriteTimer.unref?.();
	}

	private flushMainProgressSnapshot(throwOnError: boolean): void {
		if (this.progressWriteTimer) {
			clearTimeout(this.progressWriteTimer);
			this.progressWriteTimer = undefined;
		}
		const snapshot = this.pendingProgressSnapshot;
		this.pendingProgressSnapshot = undefined;
		if (snapshot === undefined) return;
		try {
			this.progressWriter(this.mainProgressPath, snapshot);
			this.lastProgressWriteAt = Date.now();
		} catch (error) {
			if (throwOnError) throw error;
		}
	}

	private buildPrompt(input: AgentTask, cwd: string, tools: string[]): string {
		const role = input.role ?? "independent coding sub-agent";
		const mutationNote = tools.some((tool) => ["bash", "edit", "write"].includes(tool))
			? "You may use the tools explicitly enabled for you, but avoid unnecessary file mutations and report every mutation you make."
			: "You are read-only. Do not attempt to modify files. Focus on analysis, evidence, and recommendations.";
		const canReadProgress = tools.includes("read");
		const progressSnapshot = this.formatMainToolProgress();

		return `You are a ${role} running as a headless sub-agent for a parent coding agent.

Working directory: ${cwd}

Task:
${input.task}

Parent main-agent progress:
${progressSnapshot}

${canReadProgress ? `The parent also writes a live progress file at ${this.mainProgressPath}. If your work depends on what the parent is doing now, read that file for a fresher snapshot before finalizing.` : `You do not have the read tool, so you only have the progress snapshot above.`}

Operating rules:
- Work independently and stay narrowly focused on the task.
- ${mutationNote}
- Prefer concrete evidence: file paths, symbol names, commands, test results, and concise reasoning.
- Do not ask the user questions. If information is missing, state assumptions.
- Do not spawn additional sub-agents.
- Use parent progress only as situational awareness; do not claim that you performed the parent's tool calls.

Return your final answer in this format:

## Summary
One short paragraph.

## Findings
- Key findings with evidence.

## Suggested Next Steps
- Concrete follow-up actions for the parent agent.
`;
	}
}
