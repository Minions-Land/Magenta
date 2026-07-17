import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	OrchestrationRequest as MultiAgentOrchestrationRequest,
	OrchestrationResult as MultiAgentOrchestrationResult,
} from "@magenta/harness";
import { type Static, Type } from "typebox";
import { APP_NAME, getAgentDir, getAgentInvocation } from "../../config.ts";
import { formatMessageUsageStats } from "../../modes/interactive/components/footer.ts";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { BackgroundEventManager } from "../background-events.ts";
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
} from "../background-shell-utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ExternalActivationReceipt } from "../external-activation-coordinator.ts";

const WORK_DIR_ROOT = join(getAgentDir(), "tmp", "sub-agents");
const TERM_GRACE_MS = 3000;
/**
 * Cap on how many finished (non-running) sub-agent events are retained.
 * Prevents unbounded growth of the events Map over a long interactive session;
 * running events and events with pending waiters are never evicted.
 */
const MAX_RETAINED_FINISHED_EVENTS = 200;
const MAX_START_MANY = 8;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const FORBIDDEN_SUB_AGENT_TOOLS = new Set(["sub_agent", "bg_shell", "teammate_agent"]);
const DEFAULT_THINKING = "medium";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DELEGATION_LEASE_NOTICE =
	"Delegation soft lease active for each running event: do not duplicate its scope. Continue only non-overlapping work, coordination, or integration preparation; after a terminal result, synthesize and independently verify it.";

type AgentStatus = "running" | "terminating" | "exited" | "failed" | "timed_out" | "cancelled";
type RequestedTerminalStatus = Extract<AgentStatus, "failed" | "timed_out" | "cancelled">;
type SubAgentOutputStream = "stdout" | "stderr" | "single";

type TerminationRequest = {
	status: RequestedTerminalStatus;
	error: string;
	signal: NodeJS.Signals | null;
};
type Action = "start" | "status" | "cancel" | "config";
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
	log: WriteStream;
	startedAt: number;
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

const TaskSchema = Type.Object({
	task: Type.String({ description: "Independent task for the sub-agent." }),
	role: Type.Optional(
		Type.String({ description: "Optional role, e.g. frontend reviewer, test analyst, security reviewer." }),
	),
	label: Type.Optional(Type.String({ description: "Short label for status listings." })),
	cwd: Type.Optional(
		Type.String({ description: "Working directory. Relative paths are resolved against the current cwd." }),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: `Allowed tools for the sub-agent. Defaults to read-only: ${DEFAULT_TOOLS.join(",")}.`,
		}),
	),
	packages: Type.Optional(
		Type.Array(Type.String(), {
			description: "Harness package selectors to load for this sub-agent (e.g. a domain package).",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: `Optional ${APP_NAME} model pattern or provider/model id. Omit or use "default" to inherit the parent model when provider is omitted.`,
		}),
	),
	provider: Type.Optional(Type.String({ description: `Optional ${APP_NAME} provider name.` })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "Optional maximum runtime before the sub-agent is terminated." }),
	),
});

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
	timeoutSeconds: Type.Optional(Type.Number({ description: "Per-worker wall-clock timeout in seconds." })),
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

const subAgentSchema = Type.Object(
	{
		action: StringEnum(["start", "status", "cancel", "config"] as const),
		workflow: Type.Optional(WorkflowSchema),
		task: Type.Optional(Type.String({ description: "Single task for action=start. Mutually exclusive with tasks." })),
		role: Type.Optional(Type.String({ description: "Optional role for action=start." })),
		label: Type.Optional(Type.String({ description: "Optional label for action=start." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for action=start." })),
		tools: Type.Optional(
			Type.Array(Type.String(), { description: `Allowed tools. Defaults to ${DEFAULT_TOOLS.join(",")}.` }),
		),
		packages: Type.Optional(
			Type.Array(Type.String(), {
				description: "Harness package selectors to load for the sub-agent(s) started by this call.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description: 'Optional model for action=start. Omit or use "default" to inherit the parent model.',
			}),
		),
		provider: Type.Optional(Type.String({ description: "Optional provider for action=start." })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Maximum runtime for action=start." })),
		tasks: Type.Optional(
			Type.Array(TaskSchema, {
				description: `Parallel tasks for action=start. Mutually exclusive with task. Maximum ${MAX_START_MANY}.`,
			}),
		),
		returnDelivery: Type.Optional(
			StringEnum(["steer", "followUp", "nextTurn"] as const, {
				description: "Delivery mode for the automatic terminal event. Default: followUp.",
			}),
		),
		returnInstruction: Type.Optional(
			Type.String({
				description: "Optional instruction prepended to the automatic return message for the parent agent.",
			}),
		),
		eventId: Type.Optional(
			Type.String({
				description: "Sub-agent identifier for status/cancel. Parameter name is 'eventId' (not 'id').",
			}),
		),
		eventIds: Type.Optional(
			Type.Array(Type.String(), {
				description: "Multiple sub-agent ids for status/cancel. Omit eventId/eventIds to target all events.",
			}),
		),
		defaultTimeoutSeconds: Type.Optional(
			Type.Number({
				description: "For action=config: set default maximum runtime for future sub-agents. Use <=0 to clear.",
			}),
		),
		defaultReturnDelivery: Type.Optional(
			StringEnum(["steer", "followUp", "nextTurn"] as const, {
				description: "For action=config: default automatic terminal delivery mode.",
			}),
		),
		defaultThinking: Type.Optional(
			StringEnum(THINKING_LEVELS, {
				description: "For action=config: default sub-agent thinking level.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SubAgentInput = Static<typeof subAgentSchema>;
type InternalSubAgentInput = SubAgentInput & {
	returnToMain?: boolean;
	waitTimeoutSeconds?: number;
};
export type SubAgentDetails = Record<string, unknown>;

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function openLogStream(path: string): Promise<WriteStream> {
	const log = createWriteStream(path, { flags: "a" });
	// Keep a permanent listener installed so a later filesystem failure cannot
	// become an uncaught EventEmitter "error". Event-specific listeners below
	// still turn such failures into terminal event state.
	log.on("error", () => {});
	return new Promise((resolveOpen, rejectOpen) => {
		const onOpen = () => {
			cleanup();
			resolveOpen(log);
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

function formatConfig(config: SubAgentConfig): string {
	return [
		"Sub-agent configuration:",
		`defaultTimeoutSeconds: ${config.defaultTimeoutSeconds ?? "none"}`,
		`defaultReturnDelivery: ${config.defaultReturnDelivery}`,
		`defaultThinking: ${config.defaultThinking}`,
	].join("\n");
}

function isEventActive(event: SubAgentEvent): boolean {
	return event.status === "running" || event.status === "terminating";
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
	if (writeLog && !event.log.writableEnded && !event.log.destroyed) event.log.write(decoded);
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
	if (!event.log.writableEnded && !event.log.destroyed) event.log.end();
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
 * The live event holds ChildProcess/WriteStream/Timer/AbortController references
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
		const stats = formatMessageUsageStats(result.usage);
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

export class SubAgentController {
	private nextAgentNumber = 1;
	private shuttingDown = false;
	private shutdownGeneration = 0;
	private reservedStarts = 0;
	private events = new Map<string, SubAgentEvent>();
	private maxRetainedFinishedEvents = MAX_RETAINED_FINISHED_EVENTS;
	private mainToolProgress = new Map<string, MainToolProgress>();
	private readonly workDir: string;
	private readonly mainProgressPath: string;
	private progressWriteChain: Promise<void> = Promise.resolve();
	private config: SubAgentConfig = {
		defaultReturnDelivery: "followUp",
		defaultThinking: DEFAULT_THINKING,
	};
	private monitor: { update: (ctx?: ExtensionContext) => void };
	private registerReturn: SubAgentRegisterReturn;
	private cancelReturn: SubAgentCancelReturn;
	private spawnAgent: SubAgentSpawn;
	private resolveAgentInvocation: typeof getAgentInvocation;
	private getDefaultModel?: () => SubAgentModelSelection | undefined;
	private getWorkflowProvider?: () => SubAgentWorkflowProvider | undefined;
	private isWorkflowEnabled: () => boolean;

	constructor(
		manager: BackgroundEventManager,
		options: {
			registerReturn: SubAgentRegisterReturn;
			cancelReturn: SubAgentCancelReturn;
			spawnAgent?: SubAgentSpawn;
			/** Explicit command override retained for embedders and tests. */
			agentCommand?: string;
			resolveAgentInvocation?: typeof getAgentInvocation;
			getDefaultModel?: () => SubAgentModelSelection | undefined;
			getWorkflowProvider?: () => SubAgentWorkflowProvider | undefined;
			isWorkflowEnabled?: () => boolean;
			/** Override the finished-event retention cap (primarily for tests). */
			maxRetainedFinishedEvents?: number;
			/** Override the namespace root (primarily for embedders and tests). */
			workDirRoot?: string;
		},
	) {
		const controllerToken = `${process.pid}-${randomUUID()}`;
		this.workDir = join(options.workDirRoot ?? WORK_DIR_ROOT, controllerToken);
		this.mainProgressPath = join(this.workDir, "main-tool-progress.md");
		this.registerReturn = options.registerReturn;
		this.cancelReturn = options.cancelReturn;
		this.spawnAgent = options.spawnAgent ?? spawn;
		this.resolveAgentInvocation = options.agentCommand
			? (args) => ({ command: options.agentCommand!, args })
			: (options.resolveAgentInvocation ?? getAgentInvocation);
		this.getDefaultModel = options.getDefaultModel;
		this.getWorkflowProvider = options.getWorkflowProvider;
		this.isWorkflowEnabled = options.isWorkflowEnabled ?? (() => true);
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
					canCancel: event.status === "running",
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
			cancelEvent: (id, ctx) => this.cancelEvent(id, ctx),
		});
	}

	createToolDefinition(): ToolDefinition<any, SubAgentDetails> {
		const workflowsEnabled = this.isWorkflowEnabled();
		return {
			name: "sub_agent",
			label: "Sub Agent",
			description: workflowsEnabled
				? `Start, inspect, or cancel sessionless, one-shot ${APP_NAME} workers whose terminal results return to the parent automatically. Use teammate_agent instead when retained context, iterative follow-up, or explicit ownership requires a long-lived managed child session. action=start accepts one task, a parallel tasks array, or a workflow object. A workflow orchestrates the same sessionless workers through one of six named presets (classify_and_act, fan_out_synthesize, adversarial_verify, generate_and_filter, tournament, loop_until_done) with fixed runtime-owned control flow. Workers are read-only by default, inherit the parent model unless overridden, run with --no-session --no-extensions, and receive parent progress.`
				: `Start, inspect, or cancel sessionless, one-shot ${APP_NAME} workers whose terminal results return to the parent automatically. Use teammate_agent instead when retained context, iterative follow-up, or explicit ownership requires a long-lived managed child session. action=start accepts one task or a parallel tasks array. Workers are read-only by default, inherit the parent model unless overridden, run with --no-session --no-extensions, and receive parent progress.`,
			promptSnippet: `Run one or more sessionless, one-shot ${APP_NAME} workers for bounded delegation`,
			promptGuidelines: [
				"Use sub_agent for bounded one-shot work. Choose teammate_agent when the collaborator needs retained context, iterative assignments, or explicit file ownership.",
				"A successful action=start gives each running event a soft lease on its delegated scope. Do not redo the same task concurrently; the parent may continue only non-overlapping Todo work, coordination, or integration preparation, then synthesize and independently verify after the terminal result returns.",
				"A read-only worker leases an analysis scope, not files. This is a coordination rule, not a runtime lock, and it does not intercept bash or other writes.",
				"After failure, timeout, or cancellation, confirm the event is terminal before reclaiming its scope.",
				"Use action=start with tasks:[...] when work decomposes into independent research, code review, test analysis, or planning subtasks that benefit from concurrent workers.",
				"Prefer default read-only workers. The parent agent should synthesize results and perform final edits.",
				`Do not start more than ${MAX_START_MANY} sub-agents at once unless the user explicitly requests a different approach; this tool enforces a hard limit of ${MAX_START_MANY} running sub-agents.`,
				"Sub-agents receive parent tool progress as situational awareness; if they need the freshest state and have read access, they can read the provided progress file.",
				"After action=start, continue only non-overlapping work. Terminal success, failure, timeout, and cancellation return through an automatic external activation; do not poll status for completion.",
				"Workers run with --no-session and --no-extensions, so they retain no session context and cannot recursively create more sub-agents.",
				...(workflowsEnabled
					? [
							"Use a workflow object when a bounded task needs orchestration over sessionless one-shot workers rather than only independent parallel tasks. Named presets provide fixed runtime-owned control flow; you supply their task slots. A workflow appears as one background event whose expansion reveals its workers.",
						]
					: []),
			],
			parameters: workflowsEnabled ? subAgentSchema : Type.Omit(subAgentSchema, ["workflow"]),
			renderKind: "sub-agent-result",
			execute: (_toolCallId, params, signal, _onUpdate, ctx) => this.execute(params as SubAgentInput, signal, ctx),
		};
	}

	handleAgentEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.shuttingDown = false;
			this.mainToolProgress.clear();
			void this.writeMainProgressSnapshot().catch(() => undefined);
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
			void this.writeMainProgressSnapshot().catch(() => undefined);
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
				void this.writeMainProgressSnapshot().catch(() => undefined);
				return;
			}
			existing.args = event.args ?? existing.args;
			existing.partialResult = event.partialResult;
			existing.updatedAt = Date.now();
			void this.writeMainProgressSnapshot().catch(() => undefined);
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
			void this.writeMainProgressSnapshot().catch(() => undefined);
		}
	}

	shutdown(): void {
		this.shuttingDown = true;
		this.shutdownGeneration += 1;
		for (const event of this.events.values()) {
			if (!isEventActive(event)) continue;
			if (event.autoReturnPending) {
				event.autoReturnPending = false;
				this.cancelReturn([event.id]);
			}
			requestTermination(event, {
				status: "cancelled",
				error: "Cancelled by session shutdown",
				signal: "SIGTERM",
			});
		}
		this.monitor.update();
	}

	private assertStartAllowed(signal: AbortSignal | undefined, generation = this.shutdownGeneration): void {
		if (signal?.aborted) throw new Error("sub_agent start was aborted");
		if (this.shuttingDown || generation !== this.shutdownGeneration) {
			throw new Error("sub_agent controller is shutting down or interrupted the start");
		}
	}

	private reserveStartSlots(
		count: number,
		signal: AbortSignal | undefined,
	): { consume: () => void; release: () => void; generation: number } {
		const generation = this.shutdownGeneration;
		this.assertStartAllowed(signal, generation);
		const running = [...this.events.values()].filter(isEventActive).length;
		const occupied = running + this.reservedStarts;
		if (occupied + count > MAX_START_MANY) {
			throw new Error(
				`Cannot start ${count} sub-agent(s): ${running} running, ${this.reservedStarts} starting, and the limit is ${MAX_START_MANY}. Continue other work until terminal results arrive, or cancel some before starting more.`,
			);
		}
		this.reservedStarts += count;
		let remaining = count;
		return {
			generation,
			consume: () => {
				if (remaining <= 0) throw new Error("sub_agent start reservation was over-consumed");
				remaining -= 1;
				this.reservedStarts -= 1;
			},
			release: () => {
				this.reservedStarts -= remaining;
				remaining = 0;
			},
		};
	}

	private async execute(params: SubAgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		const internalParams = params as InternalSubAgentInput;
		const requestedAction = String(params.action);
		if (requestedAction === "wait") return this.wait(internalParams, signal);
		const action = requestedAction as Action;
		const returnToMain = internalParams.returnToMain ?? true;
		const returnDelivery = (params.returnDelivery ?? this.config.defaultReturnDelivery) as ReturnDelivery;
		const returnInstruction = params.returnInstruction as string | undefined;

		if (action === "config") {
			if ("defaultTimeoutSeconds" in params)
				this.config.defaultTimeoutSeconds = positiveNumber(params.defaultTimeoutSeconds);
			if (params.defaultReturnDelivery) this.config.defaultReturnDelivery = params.defaultReturnDelivery;
			if (params.defaultThinking) this.config.defaultThinking = params.defaultThinking;
			return { content: [{ type: "text" as const, text: formatConfig(this.config) }], details: { ...this.config } };
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

		throw new Error(`Unsupported sub_agent action: ${action}`);
	}

	private async start(
		params: InternalSubAgentInput,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		returnToMain: boolean,
		returnDelivery: ReturnDelivery,
		returnInstruction: string | undefined,
	) {
		const hasSingle = Boolean(params.task);
		const hasTasks = Boolean(params.tasks?.length);
		if (!params.workflow && hasSingle === hasTasks) {
			throw new Error("sub_agent action=start requires exactly one of task or tasks");
		}
		const requestedSlots = params.workflow ? 1 : hasTasks ? params.tasks!.length : 1;
		if (requestedSlots > MAX_START_MANY) {
			throw new Error(`sub_agent action=start supports at most ${MAX_START_MANY} tasks`);
		}
		const reservation = this.reserveStartSlots(requestedSlots, signal);
		try {
			return await this.startReserved(
				params,
				signal,
				ctx,
				returnToMain,
				returnDelivery,
				returnInstruction,
				reservation.consume,
				reservation.generation,
			);
		} finally {
			reservation.release();
		}
	}

	private async startReserved(
		params: InternalSubAgentInput,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		returnToMain: boolean,
		returnDelivery: ReturnDelivery,
		returnInstruction: string | undefined,
		consumeReservation: () => void,
		startGeneration: number,
	) {
		// A workflow is represented by one background event and reuses the same
		// return-to-main auto-continuation as a plain worker batch.
		if (params.workflow) {
			if (!this.isWorkflowEnabled()) {
				throw new Error("sub_agent workflows are disabled for the current execution profile");
			}
			const running = [...this.events.values()].filter(isEventActive).length;
			if (running + 1 > MAX_START_MANY) {
				throw new Error(
					`Cannot start a workflow: ${running} already running and the limit is ${MAX_START_MANY}. Continue other work until terminal results arrive, or cancel some before starting more.`,
				);
			}
			const workflowPackages = normalizePackageSelectors(params.workflow.packages ?? params.packages);
			const timeoutSeconds = positiveNumber(params.timeoutSeconds) ?? this.config.defaultTimeoutSeconds;
			const event = await this.startWorkflow(
				{ ...params.workflow, packages: workflowPackages } as WorkflowInput,
				ctx.cwd,
				signal,
				timeoutSeconds,
				consumeReservation,
				startGeneration,
			);
			if (returnToMain) this.scheduleReturnToMain([event], returnDelivery, returnInstruction);
			this.monitor.update(ctx);
			const content = truncateModelText(
				`Started workflow ${event.id} (${event.label})${returnToMain ? " with automatic return to main agent" : ""}\nPattern: ${event.pattern}\nCWD: ${event.cwd}\nLog: ${event.logPath}\n${DELEGATION_LEASE_NOTICE}`,
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
					id: event.id,
					status: event.status,
					pattern: event.pattern,
					logPath: event.logPath,
					returnsToMain: returnToMain,
				},
			};
		}

		const hasSingle = Boolean(params.task);
		const hasTasks = Boolean(params.tasks?.length);
		if (hasSingle === hasTasks) throw new Error("sub_agent action=start requires exactly one of task or tasks");

		const commonTimeoutSeconds = positiveNumber(params.timeoutSeconds) ?? this.config.defaultTimeoutSeconds;
		const commonThinking = (params.thinking ?? this.config.defaultThinking) as ThinkingLevel;
		const commonPackages = normalizePackageSelectors(params.packages);
		const rawTasks = hasTasks ? (params.tasks as AgentTask[]) : [params as AgentTask];
		const tasks = rawTasks.map((task) => ({
			...task,
			packages: task.packages ?? commonPackages,
			thinking: task.thinking ?? commonThinking,
			timeoutSeconds: positiveNumber(task.timeoutSeconds) ?? commonTimeoutSeconds,
		}));
		if (tasks.length > MAX_START_MANY)
			throw new Error(`sub_agent action=start supports at most ${MAX_START_MANY} tasks`);
		const running = [...this.events.values()].filter(isEventActive).length;
		if (running + tasks.length > MAX_START_MANY) {
			throw new Error(
				`Cannot start ${tasks.length} sub-agent(s): ${running} already running and the limit is ${MAX_START_MANY}. Continue other work until terminal results arrive, or cancel some before starting more.`,
			);
		}

		const started: SubAgentEvent[] = [];
		try {
			for (const task of tasks) {
				started.push(await this.startSubAgent(task, ctx.cwd, signal, consumeReservation, startGeneration));
			}
		} catch (error) {
			for (const event of started) {
				requestTermination(event, {
					status: "cancelled",
					error: "Cancelled because another batch member failed to start",
					signal: "SIGTERM",
				});
			}
			this.monitor.update(ctx);
			throw error;
		}
		if (returnToMain) this.scheduleReturnToMain(started, returnDelivery, returnInstruction);
		this.monitor.update(ctx);

		if (started.length === 1) {
			const event = started[0]!;
			const content = truncateModelText(
				`Started sub-agent ${event.id}${event.label ? ` (${event.label})` : ""}${returnToMain ? " with automatic return to main agent" : ""}\nRole: ${event.role ?? "general"}\nCWD: ${event.cwd}\nTools: ${event.tools.join(",")}\nPrompt: ${event.promptPath}\nLog: ${event.logPath}\nParent progress: ${this.mainProgressPath}\n${DELEGATION_LEASE_NOTICE}`,
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
					id: event.id,
					status: event.status,
					promptPath: event.promptPath,
					logPath: event.logPath,
					parentProgressPath: this.mainProgressPath,
					returnsToMain: returnToMain,
				},
			};
		}

		const lines = started.map(
			(event) => `${event.id}\t${event.status}\t${event.label ?? event.role ?? "sub-agent"}\t${event.logPath}`,
		);
		const content = truncateModelText(
			`Started ${started.length} sub-agents concurrently${returnToMain ? " with automatic return to main agent" : ""}:\n${lines.join("\n")}\nParent progress: ${this.mainProgressPath}\n${DELEGATION_LEASE_NOTICE}`,
			MODEL_RESULT_TOTAL_LIMIT_BYTES,
		).text;
		return {
			content: [
				{
					type: "text" as const,
					text: content,
				},
			],
			details: {
				ids: started.map((event) => event.id),
				parentProgressPath: this.mainProgressPath,
				returnsToMain: returnToMain,
			},
		};
	}

	private status(params: SubAgentInput) {
		const ids = this.resolveEventIds(params.eventId, params.eventIds);
		if (!ids.length) return { content: [{ type: "text" as const, text: "No sub-agents." }], details: { events: 0 } };
		// Full output is only included when specific ids are requested.
		const includeOutput = Boolean(params.eventId || params.eventIds?.length);
		const summaries = ids.map((id) => {
			const event = this.events.get(id);
			if (!event) return `Unknown sub-agent: ${id}`;
			return includeOutput ? summarizeSubAgentForModel(event) : summarizeEvent(event, false);
		});
		const content = truncateModelText(summaries.join("\n\n---\n\n"), MODEL_RESULT_TOTAL_LIMIT_BYTES).text;
		return { content: [{ type: "text" as const, text: content }], details: { ids } };
	}

	/** Internal compatibility helper; intentionally absent from the public tool schema. */
	private async wait(params: InternalSubAgentInput, signal: AbortSignal | undefined) {
		const ids = this.resolveEventIds(params.eventId, params.eventIds);
		if (!ids.length) {
			return { content: [{ type: "text" as const, text: "No sub-agents to wait for." }], details: { events: 0 } };
		}
		const knownEvents = ids
			.map((id) => this.events.get(id))
			.filter((event): event is SubAgentEvent => Boolean(event));
		if (!knownEvents.length)
			throw new Error(
				truncateModelText(`No known sub-agents found: ${ids.join(", ")}`, MODEL_RESULT_LIMIT_BYTES).text,
			);

		const waitTimeoutSeconds = positiveNumber(params.waitTimeoutSeconds) ?? 30;
		const deadline = waitTimeoutSeconds ? Date.now() + waitTimeoutSeconds * 1000 : undefined;
		for (const event of knownEvents) {
			const remaining = deadline ? Math.max(0.001, (deadline - Date.now()) / 1000) : undefined;
			const result = await waitForEvent(event, remaining, signal);
			if (result === "aborted" || result === "timeout") break;
		}

		// The model is being shown these results inline now, so cancel any pending
		// returnToMain auto-delivery for the events that actually finished — that
		// avoids a duplicate "[sub-agent-return]" message and an extra triggered
		// turn. Events still running (e.g. we hit the wait timeout) keep their
		// pending auto-return so they are delivered when they eventually complete.
		for (const event of knownEvents) {
			if (!isEventActive(event) && event.autoReturnPending) {
				event.autoReturnPending = false;
				this.cancelReturn([event.id]);
			}
		}

		const perEventLimit = Math.min(
			MODEL_RESULT_LIMIT_BYTES,
			Math.max(1024, Math.floor(MODEL_RESULT_TOTAL_LIMIT_BYTES / knownEvents.length)),
		);
		const summaries = knownEvents.map((event) => summarizeSubAgentForModel(event, perEventLimit));
		const content = truncateModelText(summaries.join("\n\n---\n\n"), MODEL_RESULT_TOTAL_LIMIT_BYTES).text;
		return {
			content: [{ type: "text" as const, text: content }],
			details: {
				ids: knownEvents.map((event) => event.id),
				statuses: knownEvents.map((event) => event.status),
			},
		};
	}

	private cancel(params: SubAgentInput, ctx: ExtensionContext) {
		const ids = this.resolveEventIds(params.eventId, params.eventIds);
		if (!ids.length) {
			return { content: [{ type: "text" as const, text: "No sub-agents to cancel." }], details: { events: 0 } };
		}
		const lines: string[] = [];
		for (const id of ids) {
			const event = this.events.get(id);
			if (!event) {
				lines.push(`Unknown sub-agent: ${id}`);
				continue;
			}
			if (!isEventActive(event)) {
				lines.push(`${event.id} already ${event.status}`);
				continue;
			}
			if (event.status === "terminating") {
				lines.push(`${event.id} cancellation already requested; soft lease remains active`);
				continue;
			}
			this.cancelEvent(event.id, ctx);
			lines.push(`${event.id} cancellation requested; soft lease remains active until it settles`);
		}
		const content = truncateModelText(lines.join("\n"), MODEL_RESULT_TOTAL_LIMIT_BYTES).text;
		return { content: [{ type: "text" as const, text: content }], details: { ids } };
	}

	private async startSubAgent(
		input: AgentTask,
		parentCwd: string,
		signal: AbortSignal | undefined,
		consumeReservation: () => void,
		startGeneration: number,
	): Promise<SubAgentEvent> {
		await mkdir(this.workDir, { recursive: true });
		this.assertStartAllowed(signal, startGeneration);

		const id = `agent_${String(this.nextAgentNumber++).padStart(3, "0")}`;
		const cwd = resolve(parentCwd, input.cwd ?? ".");
		const tools = sanitizeSubAgentTools(input.tools);
		const packages = normalizePackageSelectors(input.packages);
		const thinking = input.thinking ?? DEFAULT_THINKING;
		const stamp = timestampForFile();
		const promptPath = join(this.workDir, `${id}-${stamp}.prompt.md`);
		const logPath = join(this.workDir, `${id}-${stamp}.log`);
		await this.writeMainProgressSnapshot();
		this.assertStartAllowed(signal, startGeneration);
		const prompt = this.buildPrompt(input, cwd, tools);
		await writeFile(promptPath, prompt, "utf8");
		this.assertStartAllowed(signal, startGeneration);

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

		const log = await openLogStream(logPath);
		try {
			this.assertStartAllowed(signal, startGeneration);
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
			this.assertStartAllowed(signal, startGeneration);
		} catch (error) {
			if (child) killTarget("agent", child, undefined, "SIGTERM");
			log.end();
			throw error;
		}

		const startedAt = Date.now();
		const event: SubAgentEvent = {
			id,
			kind: "agent",
			task: input.task,
			role: input.role,
			label: input.label,
			cwd,
			tools,
			packages,
			model,
			provider,
			thinking,
			promptPath,
			logPath,
			child,
			log,
			startedAt,
			status: "running",
			exitCode: null,
			signal: null,
			tail: "",
			outputDecoders: createOutputDecoders(),
			lastActivityAt: startedAt,
			activityPhase: "agent",
			waiters: [],
		};
		consumeReservation();
		this.events.set(id, event);
		this.monitor.update();
		this.pruneFinishedEvents();

		log.on("error", (error) => {
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
			this.monitor.update();
		});
		child.on("close", (code, closeSignal) => {
			finishSettledEvent(event, code === 0 ? "exited" : "failed", code, closeSignal);
			this.monitor.update();
		});

		if (input.timeoutSeconds && input.timeoutSeconds > 0) {
			event.timeout = setTimeout(() => {
				requestTermination(event, {
					status: "timed_out",
					error: `Timed out after ${input.timeoutSeconds}s`,
					signal: "SIGTERM",
				});
				this.monitor.update();
			}, input.timeoutSeconds * 1000);
		}

		return event;
	}

	private async startWorkflow(
		input: WorkflowInput,
		parentCwd: string,
		signal: AbortSignal | undefined,
		timeoutSeconds: number | undefined,
		consumeReservation: () => void,
		startGeneration: number,
	): Promise<SubAgentEvent> {
		const provider = this.getWorkflowProvider?.();
		if (!provider) {
			throw new Error("Multi-agent workflow capability is unavailable from the session HCP");
		}
		const cwd = resolve(parentCwd, ".");
		const request = { ...buildOrchestrationRequest(input), cwd } as MultiAgentOrchestrationRequest;
		await mkdir(this.workDir, { recursive: true });
		this.assertStartAllowed(signal, startGeneration);

		const id = `agent_${String(this.nextAgentNumber++).padStart(3, "0")}`;
		const stamp = timestampForFile();
		const logPath = join(this.workDir, `${id}-${stamp}.workflow.log`);
		const label = input.name?.trim() || input.pattern;
		const abort = new AbortController();
		const log = await openLogStream(logPath);
		try {
			this.assertStartAllowed(signal, startGeneration);
		} catch (error) {
			log.end();
			throw error;
		}

		const startedAt = Date.now();
		const event: SubAgentEvent = {
			id,
			kind: "workflow",
			task: label,
			label,
			pattern: input.pattern,
			cwd,
			tools: input.tools ?? [],
			packages: normalizePackageSelectors(input.packages),
			model: input.model,
			thinking: DEFAULT_THINKING,
			promptPath: logPath,
			logPath,
			abort,
			log,
			startedAt,
			status: "running",
			exitCode: null,
			signal: null,
			tail: "",
			outputDecoders: createOutputDecoders(),
			lastActivityAt: startedAt,
			activityPhase: `workflow:${input.pattern}`,
			waiters: [],
		};
		consumeReservation();
		this.events.set(id, event);
		this.monitor.update();
		this.pruneFinishedEvents();

		log.on("error", (error) => {
			if (!isEventActive(event)) return;
			requestTermination(event, {
				status: "failed",
				error: `Log stream failed: ${error.message}`,
				signal: "SIGTERM",
			});
			this.monitor.update();
		});
		log.write(`# workflow ${input.pattern}${input.name ? ` (${input.name})` : ""}\n\n`);

		if (timeoutSeconds) {
			event.timeout = setTimeout(() => {
				requestTermination(event, {
					status: "timed_out",
					error: `Timed out after ${timeoutSeconds}s`,
					signal: "SIGTERM",
				});
				this.monitor.update();
			}, timeoutSeconds * 1000);
		}

		void Promise.resolve()
			.then(() => provider.orchestrate(request, abort.signal))
			.then((result) => {
				if (!isEventActive(event)) return;
				event.workflowResult = result;
				const summary = formatWorkflowResult(result);
				appendOutput(event, "single", Buffer.from(`${summary}\n`), false);
				if (!log.writableEnded && !log.destroyed) {
					let completeResult: string;
					try {
						completeResult = JSON.stringify(result, null, 2);
					} catch {
						completeResult = summary;
					}
					log.write(`${completeResult}\n`);
				}
				const overallFailed = (result as MultiAgentOrchestrationResult & { success?: boolean }).success === false;
				const outcomeFailed = result.outcome?.success === false;
				const budgetFailed = result.terminatedBy === "budget";
				const failed = overallFailed || outcomeFailed || budgetFailed;
				const error = failed
					? (result.outcome?.error ?? `Workflow reported failure (terminatedBy=${result.terminatedBy})`)
					: undefined;
				finishSettledEvent(event, failed ? "failed" : "exited", failed ? null : 0, null, error);
				this.monitor.update();
			})
			.catch((error: unknown) => {
				if (!isEventActive(event)) return;
				const message = error instanceof Error ? error.message : String(error);
				const aborted = abort.signal.aborted;
				finishSettledEvent(event, aborted ? "cancelled" : "failed", null, aborted ? "SIGTERM" : null, message);
				this.monitor.update();
			});

		return event;
	}

	private resolveEventIds(eventId?: string, eventIds?: string[]): string[] {
		const ids = [...(eventIds ?? [])];
		if (eventId) ids.push(eventId);
		return ids.length ? ids : [...this.events.keys()];
	}

	private cancelEvent(id: string, ctx?: ExtensionContext): boolean {
		const event = this.events.get(id);
		if (!event || event.status !== "running") return false;
		const requested = requestTermination(event, {
			status: "cancelled",
			error: "Cancelled by background events UI",
			signal: "SIGTERM",
		});
		this.monitor.update(ctx);
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
		finished.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
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

	private writeMainProgressSnapshot(): Promise<void> {
		const snapshot = `${this.formatMainToolProgress()}\n`;
		const write = this.progressWriteChain.then(async () => {
			await mkdir(this.workDir, { recursive: true });
			await writeFile(this.mainProgressPath, snapshot, "utf8");
		});
		// Keep future writes moving after a failure while returning the current
		// rejection to startup callers that require a usable configuration path.
		this.progressWriteChain = write.catch(() => undefined);
		return write;
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
