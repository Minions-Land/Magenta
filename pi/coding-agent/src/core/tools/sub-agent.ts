import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
	appendTail as appendTailText,
	formatDuration,
	RESULT_LIMIT_BYTES,
	timestampForFile,
	truncateTail,
} from "../background-shell-utils.ts";
import type { BackgroundEventManager } from "../background-events.ts";
import type { AgentSessionEvent } from "../agent-session.ts";
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
	child: ChildProcess;
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

const subAgentSchema = Type.Object({
	action: StringEnum(["start", "status", "wait", "cancel", "config"] as const),
	task: Type.Optional(Type.String({ description: "Single task for action=start. Mutually exclusive with tasks." })),
	role: Type.Optional(Type.String({ description: "Optional role for action=start." })),
	label: Type.Optional(Type.String({ description: "Optional label for action=start." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for action=start." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: `Allowed tools. Defaults to ${DEFAULT_TOOLS.join(",")}.` })),
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

	constructor(
		manager: BackgroundEventManager,
		options: { sendMessage: SubAgentSendMessage; spawnAgent?: SubAgentSpawn } ,
	) {
		this.sendMessage = options.sendMessage;
		this.spawnAgent = options.spawnAgent ?? spawn;
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
				"Start, inspect, wait for, or cancel headless pi sub-agents. action=start accepts either one task or a tasks array for parallel work; set returnToMain=true to automatically send completed results back to the main agent. Sub-agents are read-only by default, run with --no-session --no-extensions, and receive parent progress.",
			promptSnippet: "Run one or more headless pi sub-agents for delegated analysis",
			promptGuidelines: [
				"Use sub_agent action=start with tasks:[...] when a task can be decomposed into independent research, code review, test analysis, or planning subtasks that benefit from concurrent agents.",
				"Prefer default read-only sub-agents. The parent agent should synthesize results and perform final edits.",
				`Do not start more than ${MAX_START_MANY} sub-agents at once unless the user explicitly requests a different approach; this tool enforces a hard limit of ${MAX_START_MANY} running sub-agents.`,
				"Sub-agents receive parent tool progress as situational awareness; if they need the freshest state and have read access, they can read the provided progress file.",
				"After sub_agent action=start, either call sub_agent action=wait before relying on results, or set returnToMain=true so results are automatically returned as a follow-up to the main agent.",
				"Sub-agents run with --no-extensions, so they cannot recursively create more sub-agents.",
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
			if (typeof params.defaultReturnToMain === "boolean") this.config.defaultReturnToMain = params.defaultReturnToMain;
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
		if (tasks.length > MAX_START_MANY) throw new Error(`sub_agent action=start supports at most ${MAX_START_MANY} tasks`);
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
		const summaries = ids.map((id) => {
			const event = this.events.get(id);
			if (!event) return `Unknown sub-agent: ${id}`;
			return summarizeEvent(event, Boolean(params.eventId || params.eventIds?.length));
		});
		return { content: [{ type: "text" as const, text: summaries.join("\n\n---\n\n") }], details: { ids } };
	}

	private async wait(params: SubAgentInput, signal: AbortSignal | undefined) {
		const ids = this.resolveEventIds(params.eventId, params.eventIds);
		if (!ids.length) {
			return { content: [{ type: "text" as const, text: "No sub-agents to wait for." }], details: { events: 0 } };
		}
		const knownEvents = ids.map((id) => this.events.get(id)).filter((event): event is SubAgentEvent => Boolean(event));
		if (!knownEvents.length) throw new Error(`No known sub-agents found: ${ids.join(", ")}`);

		const waitTimeoutSeconds = positiveNumber(params.waitTimeoutSeconds) ?? this.config.defaultWaitTimeoutSeconds;
		const deadline = waitTimeoutSeconds ? Date.now() + waitTimeoutSeconds * 1000 : undefined;
		for (const event of knownEvents) {
			const remaining = deadline ? Math.max(0.001, (deadline - Date.now()) / 1000) : undefined;
			const result = await waitForEvent(event, remaining, signal);
			if (result === "aborted" || result === "timeout") break;
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
		void (async () => {
			for (const event of completedEvents) await waitForEvent(event, undefined, undefined);
			this.returnSubAgentResultsToMain(completedEvents, delivery, instruction);
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
