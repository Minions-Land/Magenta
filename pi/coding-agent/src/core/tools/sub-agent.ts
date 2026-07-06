import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type OrchestrationRequest as MultiAgentOrchestrationRequest,
	type OrchestrationResult as MultiAgentOrchestrationResult,
	MultiAgentOrchestrator,
	type WorkerRunner as WorkflowRunner,
} from "@magenta/harness";
import { type Static, Type } from "typebox";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { BackgroundEventManager } from "../background-events.ts";
import {
	appendTail as appendTailText,
	formatDuration,
	RESULT_LIMIT_BYTES,
	timestampForFile,
	truncateTail,
} from "../background-shell-utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const WORK_DIR = join(homedir(), ".pi", "agent", "tmp", "sub-agents");
const MAIN_PROGRESS_PATH = join(WORK_DIR, "main-tool-progress.md");
const TERM_GRACE_MS = 3000;
const MAX_START_MANY = 8;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const DEFAULT_THINKING = "medium";

type AgentStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type Action = "start" | "status" | "wait" | "cancel" | "config";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type SubAgentConfig = {
	defaultTimeoutSeconds?: number;
	defaultWaitTimeoutSeconds?: number;
	defaultReturnToMain: boolean;
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
	model?: string;
	provider?: string;
	thinking: ThinkingLevel;
	promptPath: string;
	logPath: string;
	/** Event driver kind. "agent" = one child process; "workflow" = in-process orchestration. */
	kind: "agent" | "workflow";
	/** Present for kind="agent": the headless pi child process. */
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
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
	/**
	 * True while a returnToMain auto-delivery is still pending for this event.
	 * Cleared when the model synchronously consumes the result inline (via
	 * action=wait, or action=status showing the finished result) so the deferred
	 * auto-return does not redundantly re-deliver and trigger an extra turn.
	 */
	autoReturnPending?: boolean;
};

export type SubAgentSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type SubAgentReturnMessage<T = unknown> = {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: T;
	};
	options: { triggerTurn?: boolean; deliverAs?: ReturnDelivery };
};

export type SubAgentSendMessage = <T = unknown>(
	message: SubAgentReturnMessage<T>["message"],
	options?: SubAgentReturnMessage<T>["options"],
) => Promise<void> | void;

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
	model: Type.Optional(Type.String({ description: "Optional pi model pattern or provider/model id." })),
	provider: Type.Optional(Type.String({ description: "Optional pi provider name." })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "Optional maximum runtime before the sub-agent is terminated." }),
	),
});

/**
 * A workflow slot: one node in an orchestration. This is a superset of a plain
 * task (a single sub-agent is a one-node workflow), so it shares task/role/
 * model/provider/tools/thinking, plus the orchestration-only `focus`. Structured
 * output `schema` for verifier/judge/evaluator slots is enforced by the harness
 * skeleton and is intentionally NOT exposed here — the LLM fills content, never
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
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Per-worker wall-clock timeout in seconds." })),
});

/**
 * A multi-agent workflow: a deterministic orchestration skeleton (harness owns
 * the control flow) that the LLM fills with task content. Which slot fields
 * apply depends on `pattern`; unused slots are ignored. Validated at runtime by
 * the harness orchestrator, so slots are all optional here.
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
		{ description: "Which orchestration skeleton to run." },
	),
	name: Type.Optional(
		Type.String({ description: "Human-readable name shown in /events. Defaults to the pattern name." }),
	),
	model: Type.Optional(Type.String({ description: "Default model for all workers in this orchestration." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Default tool whitelist for all workers." })),
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

const subAgentSchema = Type.Object({
	action: StringEnum(["start", "status", "wait", "cancel", "config"] as const),
	workflow: Type.Optional(WorkflowSchema),
	task: Type.Optional(Type.String({ description: "Single task for action=start. Mutually exclusive with tasks." })),
	role: Type.Optional(Type.String({ description: "Optional role for action=start." })),
	label: Type.Optional(Type.String({ description: "Optional label for action=start." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for action=start." })),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: `Allowed tools. Defaults to ${DEFAULT_TOOLS.join(",")}.` }),
	),
	model: Type.Optional(Type.String({ description: "Optional model for action=start." })),
	provider: Type.Optional(Type.String({ description: "Optional provider for action=start." })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Maximum runtime for action=start." })),
	tasks: Type.Optional(
		Type.Array(TaskSchema, {
			description: `Parallel tasks for action=start. Mutually exclusive with task. Maximum ${MAX_START_MANY}.`,
		}),
	),
	returnToMain: Type.Optional(
		Type.Boolean({
			description:
				"For action=start, automatically send completed sub-agent results back to the main agent and trigger continuation. Default: false.",
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
	eventId: Type.Optional(Type.String({ description: "Single sub-agent id for status/wait/cancel." })),
	eventIds: Type.Optional(
		Type.Array(Type.String(), {
			description: "Multiple sub-agent ids for status/wait/cancel. Omit eventId/eventIds to target all events.",
		}),
	),
	waitTimeoutSeconds: Type.Optional(
		Type.Number({
			description: "Maximum time to wait for action=wait. If it expires, running sub-agents continue.",
		}),
	),
	defaultTimeoutSeconds: Type.Optional(
		Type.Number({
			description: "For action=config: set default maximum runtime for future sub-agents. Use <=0 to clear.",
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
	defaultThinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
			description: "For action=config: default sub-agent thinking level.",
		}),
	),
});

export type SubAgentInput = Static<typeof subAgentSchema>;
export type SubAgentDetails = Record<string, unknown>;

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
		`defaultWaitTimeoutSeconds: ${config.defaultWaitTimeoutSeconds ?? "none"}`,
		`defaultReturnToMain: ${config.defaultReturnToMain}`,
		`defaultReturnDelivery: ${config.defaultReturnDelivery}`,
		`defaultThinking: ${config.defaultThinking}`,
	].join("\n");
}

function appendTail(event: SubAgentEvent, data: Buffer): void {
	event.tail = appendTailText(event.tail, data);
}

function killProcessGroup(event: SubAgentEvent, signal: NodeJS.Signals): void {
	// Workflow events have no single child; cancellation is driven by the AbortController.
	if (event.kind === "workflow") {
		event.abort?.abort();
		return;
	}
	const pid = event.child?.pid;
	if (!pid) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			event.child?.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

function finishEvent(
	event: SubAgentEvent,
	status: AgentStatus,
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

function summarizeEvent(event: SubAgentEvent, includeOutput = true): string {
	if (event.kind === "workflow") return summarizeWorkflowEvent(event, includeOutput);
	const elapsedUntil = event.endedAt ?? Date.now();
	const output = truncateTail(event.tail.trimEnd());
	const lines = [
		`Sub-agent: ${event.id}${event.label ? ` (${event.label})` : ""}`,
		`Status: ${event.status}`,
		`Role: ${event.role ?? "general"}`,
		`CWD: ${event.cwd}`,
		`Tools: ${event.tools.join(",")}`,
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
			output.truncated ? `[Output truncated to last ${RESULT_LIMIT_BYTES} bytes]` : "Output:",
			output.text || "(no output yet)",
		);
	}
	return lines.join("\n");
}

function summarizeWorkflowEvent(event: SubAgentEvent, includeOutput: boolean): string {
	const elapsedUntil = event.endedAt ?? Date.now();
	const lines = [
		`Workflow: ${event.id} (${event.label})`,
		`Pattern: ${event.pattern}`,
		`Status: ${event.status}`,
		`Elapsed: ${formatDuration(elapsedUntil - event.startedAt)}`,
		`Log: ${event.logPath}`,
	];
	if (event.error) lines.push(`Error: ${event.error}`);
	if (includeOutput) {
		lines.push("", event.workflowResult ? formatWorkflowResult(event.workflowResult) : "(no result yet)");
	}
	return lines.join("\n");
}

/**
 * Map the sub_agent `workflow` tool input onto a harness OrchestrationRequest.
 * The shapes are aligned by design (WorkflowSlotSchema is a WorkerSlot superset),
 * so this is mostly a pass-through; the harness validates required slots per
 * pattern and rejects malformed requests.
 */
function buildOrchestrationRequest(input: WorkflowInput): MultiAgentOrchestrationRequest {
	const { name: _name, ...rest } = input;
	return rest as unknown as MultiAgentOrchestrationRequest;
}

/** Render an OrchestrationResult as a compact structured tree for /events + returns. */
function formatWorkflowResult(result: MultiAgentOrchestrationResult): string {
	const header = [`pattern: ${result.pattern}`, `terminatedBy: ${result.terminatedBy}`];
	if (result.confidence !== undefined) header.push(`confidence: ${result.confidence.toFixed(2)}`);
	if (result.iterations !== undefined) header.push(`iterations: ${result.iterations}`);
	const lines = [header.join(" · ")];
	const workers = result.workers ?? [];
	workers.forEach((w, i) => {
		const branch = i === workers.length - 1 && !result.outcome ? "└─" : "├─";
		const status = w.success ? "ok" : "fail";
		const text = compactValue(w.text ?? w.error ?? "", 120) ?? "";
		lines.push(`${branch} ${w.workerId} [${status}] ${text}`);
	});
	if (result.outcome) {
		const o = result.outcome;
		const text = compactValue(o.text ?? o.error ?? "", 200) ?? "";
		lines.push(`└─ outcome [${o.success ? "ok" : "fail"}] ${text}`);
	}
	return lines.join("\n");
}

function waitForEvent(
	event: SubAgentEvent,
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

export class SubAgentController {
	private nextAgentNumber = 1;
	private shuttingDown = false;
	private events = new Map<string, SubAgentEvent>();
	private mainToolProgress = new Map<string, MainToolProgress>();
	private config: SubAgentConfig = {
		defaultReturnToMain: false,
		defaultReturnDelivery: "followUp",
		defaultThinking: DEFAULT_THINKING,
	};
	private monitor: { update: (ctx?: ExtensionContext) => void };
	private sendMessage: SubAgentSendMessage;
	private spawnAgent: SubAgentSpawn;
	private workflowRunner?: WorkflowRunner;

	constructor(
		manager: BackgroundEventManager,
		options: { sendMessage: SubAgentSendMessage; spawnAgent?: SubAgentSpawn; workflowRunner?: WorkflowRunner },
	) {
		this.sendMessage = options.sendMessage;
		this.spawnAgent = options.spawnAgent ?? spawn;
		this.workflowRunner = options.workflowRunner;
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

	createToolDefinition(): ToolDefinition<typeof subAgentSchema, SubAgentDetails> {
		return {
			name: "sub_agent",
			label: "Sub Agent",
			description:
				"Start, inspect, wait for, or cancel headless pi sub-agents. action=start accepts either one task or a tasks array for parallel work, or a workflow object to run a deterministic multi-agent orchestration (classify_and_act, fan_out_synthesize, adversarial_verify, generate_and_filter, tournament, loop_until_done). Set returnToMain=true to automatically send completed results back to the main agent. Sub-agents are read-only by default, run with --no-session --no-extensions, and receive parent progress.",
			promptSnippet: "Run one or more headless pi sub-agents for delegated analysis",
			promptGuidelines: [
				"Use sub_agent action=start with tasks:[...] when a task can be decomposed into independent research, code review, test analysis, or planning subtasks that benefit from concurrent agents.",
				"Prefer default read-only sub-agents. The parent agent should synthesize results and perform final edits.",
				`Do not start more than ${MAX_START_MANY} sub-agents at once unless the user explicitly requests a different approach; this tool enforces a hard limit of ${MAX_START_MANY} running sub-agents.`,
				"Sub-agents receive parent tool progress as situational awareness; if they need the freshest state and have read access, they can read the provided progress file.",
				"After sub_agent action=start, either call sub_agent action=wait before relying on results, or set returnToMain=true so results are automatically returned as a follow-up to the main agent — use one or the other, not both. If you wait (or view a finished agent via action=status) the pending automatic return is cancelled, so you will not get a duplicate return.",
				"Sub-agents run with --no-extensions, so they cannot recursively create more sub-agents.",
				"Use action=start with a workflow object when the task needs a structured multi-agent pattern (route-and-handle, fan-out-and-synthesize, generate-and-verify, candidate tournament, or iterate-until-done) rather than independent parallel tasks. The orchestration control flow is deterministic and owned by the harness; you only supply each slot's task content. A workflow shows up as a single background event whose expansion reveals its internal workers.",
			],
			parameters: subAgentSchema,
			execute: (_toolCallId, params, signal, _onUpdate, ctx) => this.execute(params, signal, ctx),
		};
	}

	handleAgentEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.shuttingDown = false;
			this.mainToolProgress.clear();
			this.writeMainProgressSnapshot();
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
			this.writeMainProgressSnapshot();
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
				this.writeMainProgressSnapshot();
				return;
			}
			existing.args = event.args ?? existing.args;
			existing.partialResult = event.partialResult;
			existing.updatedAt = Date.now();
			this.writeMainProgressSnapshot();
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
			this.writeMainProgressSnapshot();
		}
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

	private async execute(params: SubAgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		const action = params.action as Action;
		const returnToMain = params.returnToMain ?? this.config.defaultReturnToMain;
		const returnDelivery = (params.returnDelivery ?? this.config.defaultReturnDelivery) as ReturnDelivery;
		const returnInstruction = params.returnInstruction as string | undefined;

		if (action === "config") {
			if ("defaultTimeoutSeconds" in params)
				this.config.defaultTimeoutSeconds = positiveNumber(params.defaultTimeoutSeconds);
			if ("defaultWaitTimeoutSeconds" in params)
				this.config.defaultWaitTimeoutSeconds = positiveNumber(params.defaultWaitTimeoutSeconds);
			if (typeof params.defaultReturnToMain === "boolean")
				this.config.defaultReturnToMain = params.defaultReturnToMain;
			if (params.defaultReturnDelivery) this.config.defaultReturnDelivery = params.defaultReturnDelivery;
			if (params.defaultThinking) this.config.defaultThinking = params.defaultThinking;
			return { content: [{ type: "text" as const, text: formatConfig(this.config) }], details: { ...this.config } };
		}

		if (action === "start") {
			return this.start(params, ctx, returnToMain, returnDelivery, returnInstruction);
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

		throw new Error(`Unsupported sub_agent action: ${action}`);
	}

	private async start(
		params: SubAgentInput,
		ctx: ExtensionContext,
		returnToMain: boolean,
		returnDelivery: ReturnDelivery,
		returnInstruction: string | undefined,
	) {
		// Workflow branch: a multi-agent orchestration. The harness owns the
		// deterministic control flow; this facade only manages it as one background
		// event and reuses the same return-to-main auto-continuation.
		if (params.workflow) {
			const running = [...this.events.values()].filter((event) => event.status === "running").length;
			if (running + 1 > MAX_START_MANY) {
				throw new Error(
					`Cannot start a workflow: ${running} already running and the limit is ${MAX_START_MANY}. Wait or cancel some before starting more.`,
				);
			}
			const event = this.startWorkflow(params.workflow as WorkflowInput, ctx.cwd);
			if (returnToMain) this.scheduleReturnToMain([event], returnDelivery, returnInstruction);
			this.monitor.update(ctx);
			return {
				content: [
					{
						type: "text" as const,
						text: `Started workflow ${event.id} (${event.label})${returnToMain ? " with automatic return to main agent" : ""}\nPattern: ${event.pattern}\nCWD: ${event.cwd}\nLog: ${event.logPath}`,
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
		const rawTasks = hasTasks ? (params.tasks as AgentTask[]) : [params as AgentTask];
		const tasks = rawTasks.map((task) => ({
			...task,
			thinking: task.thinking ?? commonThinking,
			timeoutSeconds: positiveNumber(task.timeoutSeconds) ?? commonTimeoutSeconds,
		}));
		if (tasks.length > MAX_START_MANY)
			throw new Error(`sub_agent action=start supports at most ${MAX_START_MANY} tasks`);
		const running = [...this.events.values()].filter((event) => event.status === "running").length;
		if (running + tasks.length > MAX_START_MANY) {
			throw new Error(
				`Cannot start ${tasks.length} sub-agent(s): ${running} already running and the limit is ${MAX_START_MANY}. Wait or cancel some before starting more.`,
			);
		}

		const started: SubAgentEvent[] = [];
		for (const task of tasks) started.push(await this.startSubAgent(task, ctx.cwd));
		if (returnToMain) this.scheduleReturnToMain(started, returnDelivery, returnInstruction);
		this.monitor.update(ctx);

		if (started.length === 1) {
			const event = started[0]!;
			return {
				content: [
					{
						type: "text" as const,
						text: `Started sub-agent ${event.id}${event.label ? ` (${event.label})` : ""}${returnToMain ? " with automatic return to main agent" : ""}\nRole: ${event.role ?? "general"}\nCWD: ${event.cwd}\nTools: ${event.tools.join(",")}\nPrompt: ${event.promptPath}\nLog: ${event.logPath}\nParent progress: ${MAIN_PROGRESS_PATH}`,
					},
				],
				details: {
					id: event.id,
					status: event.status,
					promptPath: event.promptPath,
					logPath: event.logPath,
					parentProgressPath: MAIN_PROGRESS_PATH,
					returnsToMain: returnToMain,
				},
			};
		}

		const lines = started.map(
			(event) => `${event.id}\t${event.status}\t${event.label ?? event.role ?? "sub-agent"}\t${event.logPath}`,
		);
		return {
			content: [
				{
					type: "text" as const,
					text: `Started ${started.length} sub-agents concurrently${returnToMain ? " with automatic return to main agent" : ""}:\n${lines.join("\n")}\nParent progress: ${MAIN_PROGRESS_PATH}`,
				},
			],
			details: {
				ids: started.map((event) => event.id),
				parentProgressPath: MAIN_PROGRESS_PATH,
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
			// If the model is shown a finished event's full result inline here, a
			// pending returnToMain auto-delivery for it would be redundant — cancel
			// it. Polling a still-running agent must not cancel.
			if (includeOutput && event.status !== "running") event.autoReturnPending = false;
			return summarizeEvent(event, includeOutput);
		});
		return { content: [{ type: "text" as const, text: summaries.join("\n\n---\n\n") }], details: { ids } };
	}

	private async wait(params: SubAgentInput, signal: AbortSignal | undefined) {
		const ids = this.resolveEventIds(params.eventId, params.eventIds);
		if (!ids.length) {
			return { content: [{ type: "text" as const, text: "No sub-agents to wait for." }], details: { events: 0 } };
		}
		const knownEvents = ids
			.map((id) => this.events.get(id))
			.filter((event): event is SubAgentEvent => Boolean(event));
		if (!knownEvents.length) throw new Error(`No known sub-agents found: ${ids.join(", ")}`);

		const waitTimeoutSeconds = positiveNumber(params.waitTimeoutSeconds) ?? this.config.defaultWaitTimeoutSeconds;
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
			if (event.status !== "running") event.autoReturnPending = false;
		}

		const summaries = knownEvents.map((event) => summarizeEvent(event));
		return {
			content: [{ type: "text" as const, text: summaries.join("\n\n---\n\n") }],
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
			if (event.status !== "running") {
				lines.push(`${event.id} already ${event.status}`);
				continue;
			}
			this.cancelEvent(event.id, ctx);
			lines.push(`${event.id} cancelled`);
		}
		return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ids } };
	}

	private async startSubAgent(input: AgentTask, parentCwd: string): Promise<SubAgentEvent> {
		await mkdir(WORK_DIR, { recursive: true });

		const id = `agent_${String(this.nextAgentNumber++).padStart(3, "0")}`;
		const cwd = resolve(parentCwd, input.cwd ?? ".");
		const tools = input.tools?.length ? input.tools : DEFAULT_TOOLS;
		const thinking = input.thinking ?? DEFAULT_THINKING;
		const stamp = timestampForFile();
		const promptPath = join(WORK_DIR, `${id}-${stamp}.prompt.md`);
		const logPath = join(WORK_DIR, `${id}-${stamp}.log`);
		await writeFile(MAIN_PROGRESS_PATH, `${this.formatMainToolProgress()}\n`, "utf8");
		const prompt = this.buildPrompt(input, cwd, tools);
		await writeFile(promptPath, prompt, "utf8");

		const args = ["--print", "--no-session", "--no-extensions", "--tools", tools.join(","), "--thinking", thinking];
		if (input.provider) args.push("--provider", input.provider);
		if (input.model) args.push("--model", input.model);
		args.push(`@${promptPath}`);

		const log = createWriteStream(logPath, { flags: "a" });
		const child = this.spawnAgent("pi", args, {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SUB_AGENT: "1" },
		});

		const event: SubAgentEvent = {
			id,
			kind: "agent",
			task: input.task,
			role: input.role,
			label: input.label,
			cwd,
			tools,
			model: input.model,
			provider: input.provider,
			thinking,
			promptPath,
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
		this.events.set(id, event);
		this.monitor.update();

		log.write(`$ pi ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
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
			this.monitor.update();
		});
		child.on("close", (code, closeSignal) => {
			if (event.status === "timed_out" || event.status === "cancelled") return;
			finishEvent(event, code === 0 ? "exited" : "failed", code, closeSignal);
			this.monitor.update();
		});

		if (input.timeoutSeconds && input.timeoutSeconds > 0) {
			event.timeout = setTimeout(() => {
				finishEvent(event, "timed_out", null, "SIGTERM", `Timed out after ${input.timeoutSeconds}s`);
				this.monitor.update();
				killProcessGroup(event, "SIGTERM");
				setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
			}, input.timeoutSeconds * 1000);
		}

		return event;
	}

	private startWorkflow(input: WorkflowInput, parentCwd: string): SubAgentEvent {
		const id = `agent_${String(this.nextAgentNumber++).padStart(3, "0")}`;
		const cwd = resolve(parentCwd, ".");
		const stamp = timestampForFile();
		const logPath = join(WORK_DIR, `${id}-${stamp}.workflow.log`);
		const label = input.name?.trim() || input.pattern;
		const abort = new AbortController();
		void mkdir(WORK_DIR, { recursive: true }).catch(() => undefined);
		const log = createWriteStream(logPath, { flags: "a" });

		const event: SubAgentEvent = {
			id,
			kind: "workflow",
			task: label,
			label,
			pattern: input.pattern,
			cwd,
			tools: input.tools ?? [],
			model: input.model,
			thinking: DEFAULT_THINKING,
			promptPath: logPath,
			logPath,
			abort,
			log,
			startedAt: Date.now(),
			status: "running",
			exitCode: null,
			signal: null,
			tail: "",
			waiters: [],
		};
		this.events.set(id, event);
		this.monitor.update();

		const request = buildOrchestrationRequest(input);
		log.write(`# workflow ${input.pattern}${input.name ? ` (${input.name})` : ""}\n\n`);
		const orchestrator = new MultiAgentOrchestrator({ cwd, runner: this.workflowRunner });

		void orchestrator
			.orchestrate(request, abort.signal)
			.then((result) => {
				if (event.status !== "running") return;
				event.workflowResult = result;
				const summary = formatWorkflowResult(result);
				event.tail = appendTailText(event.tail, Buffer.from(`${summary}\n`));
				if (!log.writableEnded && !log.destroyed) log.write(`${summary}\n`);
				finishEvent(event, "exited", 0, null);
				this.monitor.update();
			})
			.catch((error: unknown) => {
				if (event.status !== "running") return;
				const message = error instanceof Error ? error.message : String(error);
				const aborted = abort.signal.aborted;
				finishEvent(event, aborted ? "cancelled" : "failed", null, aborted ? "SIGTERM" : null, message);
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
		finishEvent(event, "cancelled", null, "SIGTERM", "Cancelled by background events UI");
		this.monitor.update(ctx);
		killProcessGroup(event, "SIGTERM");
		setTimeout(() => killProcessGroup(event, "SIGKILL"), TERM_GRACE_MS);
		return true;
	}

	private returnSubAgentResultsToMain(
		completedEvents: SubAgentEvent[],
		delivery: ReturnDelivery,
		instruction?: string,
	): void {
		if (this.shuttingDown || completedEvents.length === 0) return;

		const summaries = completedEvents.map((event) => summarizeEvent(event)).join("\n\n---\n\n");
		const defaultInstruction =
			"Sub-agent work has completed. Read these returned results, synthesize the findings, and continue the original task. Do not ask the user to manually inspect event ids unless more information is needed.";
		void this.sendMessage(
			{
				customType: "sub-agent-return",
				content: `${instruction?.trim() || defaultInstruction}\n\n${summaries}`,
				display: true,
				details: {
					ids: completedEvents.map((event) => event.id),
					statuses: completedEvents.map((event) => event.status),
				},
			},
			{ deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
		);
	}

	private scheduleReturnToMain(
		completedEvents: SubAgentEvent[],
		delivery: ReturnDelivery,
		instruction?: string,
	): void {
		// Mark these events as awaiting an auto-return. If the model synchronously
		// consumes their results this turn (action=wait / status), that handler
		// clears the flag so we don't redundantly deliver + trigger another turn.
		for (const event of completedEvents) event.autoReturnPending = true;
		void (async () => {
			for (const event of completedEvents) await waitForEvent(event, undefined, undefined);
			// Yield once so a wait/status tool call resolving on the same tick as the
			// final completion clears its flag before we read it (avoids a race where
			// the auto-return still fires for the last-finishing event).
			await Promise.resolve();
			const pending = completedEvents.filter((event) => event.autoReturnPending);
			if (pending.length === 0) return;
			for (const event of pending) event.autoReturnPending = false;
			this.returnSubAgentResultsToMain(pending, delivery, instruction);
		})().catch(() => undefined);
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

	private writeMainProgressSnapshot(): void {
		void mkdir(WORK_DIR, { recursive: true })
			.then(() => writeFile(MAIN_PROGRESS_PATH, `${this.formatMainToolProgress()}\n`, "utf8"))
			.catch(() => undefined);
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

${canReadProgress ? `The parent also writes a live progress file at ${MAIN_PROGRESS_PATH}. If your work depends on what the parent is doing now, read that file for a fresher snapshot before finalizing.` : `You do not have the read tool, so you only have the progress snapshot above.`}

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
