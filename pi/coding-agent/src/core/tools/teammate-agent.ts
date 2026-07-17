import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createWriteStream, existsSync, openSync, type WriteStream } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { uuidv7 } from "@magenta/harness";
import { type Static, Type } from "typebox";
import {
	APP_NAME,
	ENV_AGENT_DIR,
	ENV_PEER_MESSAGE_DB,
	ENV_TEAMMATE_PARENT_SESSION_ID,
	getAgentInvocation,
} from "../../config.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState } from "../../modes/rpc/rpc-types.ts";
import type { SessionStats } from "../agent-session.ts";
import type { BackgroundEventManager, EventUiTelemetry } from "../background-events.ts";
import {
	appendTail as appendTailText,
	formatDuration,
	timestampForFile,
	truncateModelText,
	truncateTail,
} from "../background-shell-utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import type { PeerMessageDetails, PeerSendInput } from "./send-message.ts";
import {
	type TeammateChangeReceipt,
	TeammateWorktreeManager,
	type TeammateWorktreeRecord,
} from "./teammate-worktree.ts";

const MAX_TEAMMATES = 8;
const RPC_TIMEOUT_MS = 30_000;
const GRACEFUL_STOP_MS = 1_000;
const TERM_GRACE_MS = 3_000;
const UI_TELEMETRY_TTL_MS = 2_000;
const DEFAULT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"send_message",
	"show",
	"grep",
	"find",
	"ls",
	"web-search",
	"web-fetch",
];
const FORBIDDEN_TOOLS = new Set(["teammate_agent", "sub_agent", "bg_shell"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TEAMMATE_LEASE_NOTICE =
	"Soft assignment lease active until a result or confirmed terminal stop/cancel: do not duplicate its scope. Idle does not release it; continue only non-overlapping work, coordination, or integration preparation, then synthesize and independently verify the result.";
const HUMAN_HANDOFF_CONTEXT_MAX_BYTES = 16 * 1024;
const HUMAN_HANDOFF_SHORTENED_MARKER = "\n\n[Side/BTW handoff context shortened at the managed-teammate boundary.]\n\n";
export const HUMAN_SIDE_HANDOFF_CUSTOM_TYPE = "magenta-human-side-handoff.v1";

type TeammateProcessStatus = "running" | "stopped" | "failed";
type TeammateActivity = "starting" | "idle" | "active" | "interrupting" | "stopping";
type TeammateAction = "start" | "status" | "send" | "interrupt" | "stop" | "resume" | "integrate" | "discard";
type TeammateAssignmentStatus = "active" | "completed" | "failed" | "blocked" | "cancelled";

type TeammateAssignment = {
	id: string;
	messageId: string;
	status: TeammateAssignmentStatus;
	startedAt: number;
	completedAt?: number;
	terminalMessageId?: string;
	waiters: Array<() => void>;
};

type TeammateEvent = {
	id: string;
	label: string;
	cwd: string;
	sessionId: string;
	sessionFile: string;
	parentSessionId: string;
	parentSessionFile?: string;
	tools: string[];
	model?: string;
	provider?: string;
	thinking: ThinkingLevel;
	logPath: string;
	log: WriteStream;
	child: ChildProcess;
	startedAt: number;
	endedAt?: number;
	status: TeammateProcessStatus;
	activity: TeammateActivity;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	lastOutput?: string;
	lastActivityAt: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	activityPhase: string;
	autoCompactEnabled?: boolean;
	uiTelemetry?: EventUiTelemetry;
	uiTelemetryFetchedAt?: number;
	uiTelemetryInFlight?: Promise<void>;
	generation: number;
	stopping: boolean;
	stopPromise?: Promise<void>;
	stopReadingStdout?: () => void;
	pendingRequests: Map<
		string,
		{
			resolve: (response: RpcResponse) => void;
			reject: (error: Error) => void;
			timer: NodeJS.Timeout;
			activityNeutral: boolean;
		}
	>;
	waiters: Array<() => void>;
	workspace: "shared" | "worktree";
	worktree?: TeammateWorktreeRecord;
	receiptPromise?: Promise<TeammateChangeReceipt | undefined>;
	assignments: Map<string, TeammateAssignment>;
	currentAssignmentId?: string;
	nextAssignmentNumber: number;
	terminalNotificationSent?: boolean;
	humanHandoff?: PreparedHumanSideHandoff & { bootstrapMessageId?: string };
};

export type TeammateAgentSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type TeammateAgentModelSelection = {
	provider: string;
	model: string;
};

export type TeammatePeerSend = (params: PeerSendInput) => {
	content: { type: "text"; text: string }[];
	details: PeerMessageDetails;
};

export type HumanSideHandoffRequest = {
	confirmed: true;
	origin: "side" | "btw";
	conversationId: string;
	label: string;
	context: string;
	messageCount: number;
	originalBytes: number;
	truncated: boolean;
};

export type HumanSideHandoffResult = {
	handoffId: string;
	teammateId: string;
	sessionId: string;
	bootstrapMessageId: string;
	contextBytes: number;
	contextTruncated: boolean;
};

type PreparedHumanSideHandoff = Omit<HumanSideHandoffRequest, "confirmed" | "context"> & {
	handoffId: string;
	context: string;
	contextBytes: number;
};

function humanHandoffDetails(
	handoff: PreparedHumanSideHandoff & { bootstrapMessageId?: string },
): Record<string, unknown> {
	return {
		handoffId: handoff.handoffId,
		origin: handoff.origin,
		conversationId: handoff.conversationId,
		label: handoff.label,
		messageCount: handoff.messageCount,
		originalBytes: handoff.originalBytes,
		contextBytes: handoff.contextBytes,
		truncated: handoff.truncated,
		...(handoff.bootstrapMessageId ? { bootstrapMessageId: handoff.bootstrapMessageId } : {}),
	};
}

const teammateAgentSchema = Type.Object(
	{
		action: StringEnum(["start", "status", "send", "interrupt", "stop", "resume", "integrate", "discard"] as const),
		teammateId: Type.Optional(
			Type.String({
				description:
					"Managed teammate identifier for status/send/interrupt/stop. Omit for action=status to list all teammates.",
			}),
		),
		label: Type.Optional(Type.String({ description: "Human-readable teammate name for action=start." })),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for action=start. Relative paths resolve from the main session cwd.",
			}),
		),
		workspace: Type.Optional(
			StringEnum(["shared", "worktree"] as const, {
				description:
					"Workspace mode for action=start. Use worktree for isolated editing and explicit integrate/discard; shared is intended for read-only collaboration. Defaults to shared.",
			}),
		),
		tools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Tool allowlist for the managed child session. send_message is always added; teammate_agent, sub_agent, and bg_shell are always removed.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description: `Optional ${APP_NAME} model pattern or provider/model id. Omit or use "default" to inherit the parent model when provider is omitted.`,
			}),
		),
		provider: Type.Optional(Type.String({ description: `Optional ${APP_NAME} provider name.` })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
		message: Type.Optional(
			Type.String({
				description:
					"Optional first assignment for action=start, work assignment for action=send, or replacement instruction for interrupt.",
			}),
		),
		urgent: Type.Optional(
			Type.Boolean({
				description:
					"For action=send, wake an idle teammate and steer an active teammate. Defaults to true. Interrupt is always urgent.",
			}),
		),
		confirm: Type.Optional(
			Type.Boolean({
				description: "Required as true for action=discard because it permanently removes the worktree.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type TeammateAgentInput = Static<typeof teammateAgentSchema>;
type InternalTeammateAgentInput = TeammateAgentInput & {
	assignmentId?: string;
	waitTimeoutSeconds?: number;
};
export type TeammateAgentDetails = Record<string, unknown>;

function sanitizeTools(requested: string[] | undefined): string[] {
	const selected = requested?.length ? requested : DEFAULT_TOOLS;
	const tools = selected.map((name) => name.trim()).filter((name) => name && !FORBIDDEN_TOOLS.has(name));
	if (!tools.includes("send_message")) tools.push("send_message");
	return [...new Set(tools)];
}

function appendTail(event: TeammateEvent, text: string): void {
	event.tail = appendTailText(event.tail, Buffer.from(text, "utf8"));
	if (text.trim().length > 0) {
		const now = Date.now();
		event.lastOutputAt = now;
		event.lastActivityAt = now;
	}
}

function setActivity(event: TeammateEvent, activity: TeammateActivity): void {
	if (event.activity === activity && event.activityPhase === activity) return;
	event.activity = activity;
	event.activityPhase = activity;
	event.lastActivityAt = Date.now();
}

function killProcessGroup(event: TeammateEvent, signal: NodeJS.Signals): void {
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

function settleEvent(
	event: TeammateEvent,
	generation: number,
	status: TeammateProcessStatus,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	error?: string,
): void {
	if (event.generation !== generation || event.status !== "running") return;
	event.status = status;
	event.exitCode = exitCode;
	event.signal = signal;
	event.error = error;
	event.endedAt = Date.now();
	event.stopReadingStdout?.();
	event.stopReadingStdout = undefined;
	if (!event.log.writableEnded && !event.log.destroyed) event.log.end();
	const requestError = new Error(error ?? `Teammate ${event.id} ${status}`);
	for (const pending of event.pendingRequests.values()) {
		clearTimeout(pending.timer);
		pending.reject(requestError);
	}
	event.pendingRequests.clear();
	for (const resolveWaiter of event.waiters.splice(0)) resolveWaiter();
}

function summarizeEvent(event: TeammateEvent, includeOutput = true): string {
	const elapsedUntil = event.endedAt ?? Date.now();
	const lines = [
		`Teammate: ${event.id} (${event.label})`,
		`Process: ${event.status}`,
		`Activity: ${event.activity}`,
		`Session ID: ${event.sessionId}`,
		`Parent session ID: ${event.parentSessionId}`,
		`CWD: ${event.cwd}`,
		`Workspace: ${event.workspace}${event.worktree ? ` (${event.worktree.state})` : ""}`,
		...(event.worktree
			? [
					`Worktree: ${event.worktree.checkoutPath}`,
					`Branch: ${event.worktree.branch}`,
					`Collaboration: ${event.worktree.collaborationRoot}`,
				]
			: []),
		`Assignment: ${event.currentAssignmentId ?? "none"}${event.currentAssignmentId ? ` (${event.assignments.get(event.currentAssignmentId)?.status ?? "unknown"})` : ""}`,
		...(event.humanHandoff
			? [
					`Human handoff: ${event.humanHandoff.handoffId} (${event.humanHandoff.origin}:${event.humanHandoff.conversationId})`,
				]
			: []),
		`Tools: ${event.tools.join(",")}`,
		`Model: ${event.model ?? "default"}`,
		`Thinking: ${event.thinking}`,
		`Elapsed: ${formatDuration(elapsedUntil - event.startedAt)}`,
		`Exit code: ${event.exitCode ?? "n/a"}`,
		`Signal: ${event.signal ?? "n/a"}`,
		`Session: ${event.sessionFile}`,
		`Log: ${event.logPath}`,
	];
	if (event.error) lines.push(`Error: ${event.error}`);
	if (event.worktree?.receipt) {
		lines.push(
			`Receipt: ${event.worktree.receipt.patchSha256} (${event.worktree.receipt.patchBytes} bytes, ${event.worktree.receipt.changedFiles.length} files)`,
		);
	}
	if (includeOutput) {
		const output = truncateTail(event.lastOutput ?? event.tail.trimEnd());
		lines.push("", "Latest output:", output.text || "(no output yet)");
	}
	return lines.join("\n");
}

function waitForExit(event: TeammateEvent, timeoutMs: number): Promise<boolean> {
	if (event.status !== "running") return Promise.resolve(true);
	return new Promise((resolveWait) => {
		let settled = false;
		let waiter: () => void;
		const done = (closed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const index = event.waiters.indexOf(waiter);
			if (index >= 0) event.waiters.splice(index, 1);
			resolveWait(closed);
		};
		waiter = () => done(true);
		event.waiters.push(waiter);
		const timer = setTimeout(() => done(false), timeoutMs);
	});
}

export class TeammateAgentController {
	private nextTeammateNumber = 1;
	private nextRequestNumber = 1;
	private shuttingDown = false;
	private events = new Map<string, TeammateEvent>();
	private monitor: { update: (ctx?: ExtensionContext) => void };
	private sendPeerMessage: TeammatePeerSend;
	private getUnreadPeerMessageCount: (sessionId: string) => number;
	private spawnAgent: TeammateAgentSpawn;
	private resolveAgentInvocation: typeof getAgentInvocation;
	private getParentSessionId: () => string;
	private getParentSessionFile: () => string | undefined;
	private getParentSessionDir: () => string;
	private getAgentDirPath: () => string;
	private getPeerMessageDbPath: () => string;
	private getDefaultModel?: () => TeammateAgentModelSelection | undefined;
	private createSessionId: () => string;
	private isEnabled: () => boolean;
	private worktrees: TeammateWorktreeManager;

	constructor(
		manager: BackgroundEventManager,
		options: {
			sendPeerMessage: TeammatePeerSend;
			getUnreadPeerMessageCount: (sessionId: string) => number;
			getParentSessionId: () => string;
			getParentSessionFile: () => string | undefined;
			getParentSessionDir: () => string;
			getAgentDirPath: () => string;
			getPeerMessageDbPath: () => string;
			getDefaultModel?: () => TeammateAgentModelSelection | undefined;
			spawnAgent?: TeammateAgentSpawn;
			/** Explicit command override retained for embedders and tests. */
			agentCommand?: string;
			resolveAgentInvocation?: typeof getAgentInvocation;
			createSessionId?: () => string;
			isEnabled?: () => boolean;
			worktreeManager?: TeammateWorktreeManager;
		},
	) {
		this.sendPeerMessage = options.sendPeerMessage;
		this.getUnreadPeerMessageCount = options.getUnreadPeerMessageCount;
		this.getParentSessionId = options.getParentSessionId;
		this.getParentSessionFile = options.getParentSessionFile;
		this.getParentSessionDir = options.getParentSessionDir;
		this.getAgentDirPath = options.getAgentDirPath;
		this.getPeerMessageDbPath = options.getPeerMessageDbPath;
		this.getDefaultModel = options.getDefaultModel;
		this.spawnAgent = options.spawnAgent ?? spawn;
		this.resolveAgentInvocation = options.agentCommand
			? (args) => ({ command: options.agentCommand!, args })
			: (options.resolveAgentInvocation ?? getAgentInvocation);
		this.createSessionId = options.createSessionId ?? uuidv7;
		this.isEnabled = options.isEnabled ?? (() => true);
		this.worktrees = options.worktreeManager ?? new TeammateWorktreeManager();
		this.monitor = manager.registerSource({
			id: "teammates",
			title: "teammates",
			getEvents: () =>
				[...this.events.values()].map((event) => ({
					id: event.id,
					status: event.status,
					startedAt: event.startedAt,
					endedAt: event.endedAt,
					label: `${event.label} · ${event.activity}`,
					cwd: event.cwd,
					logPath: event.logPath,
					tail: event.lastOutput ?? event.tail,
					lastActivityAt: event.lastActivityAt,
					lastOutputAt: event.lastOutputAt,
					lastProgressAt: event.lastProgressAt,
					activityPhase: event.activityPhase,
					reminderEligible: event.status === "running" && event.activity !== "idle",
					canCancel: event.status === "running",
				})),
			getEventDetails: (id) => {
				const event = this.events.get(id);
				return event ? summarizeEvent(event).split("\n") : [`unknown teammate event: ${id}`];
			},
			getUiTelemetry: (id, onUpdate) => {
				const event = this.events.get(id);
				return event ? this.getUiTelemetry(event, onUpdate) : undefined;
			},
			cancelEvent: (id, ctx) => {
				const event = this.events.get(id);
				if (!event || event.status !== "running") return false;
				void this.stopEvent(event, ctx);
				return true;
			},
		});
	}

	createToolDefinition(): ToolDefinition<typeof teammateAgentSchema, TeammateAgentDetails> {
		return {
			name: "teammate_agent",
			label: "Teammate Agent",
			description: `Create and control parent-managed, long-lived hidden ${APP_NAME} child sessions during the current parent runtime. teammate_agent is the lifecycle/control plane; editing teammates can use a parent-session-scoped Git worktree, produce an immutable change receipt, and integrate or discard it explicitly. Assignment/result payloads travel through send_message with structured terminal receipts.`,
			promptSnippet: `Create, assign, integrate, discard, resume, or stop parent-managed ${APP_NAME} child sessions`,
			promptGuidelines: [
				"Use teammate_agent when collaboration needs retained context, multiple assignments, iterative follow-up, or explicit file ownership. Use sessionless sub_agent workers for bounded one-shot delegation.",
				"teammate_agent creates and manages child-session lifecycle. All assignment and result payloads travel through send_message; the RPC channel controls state, interrupt, resume, and shutdown.",
				"Successful assignment delivery creates a soft lease on its stated scope. Do not duplicate that work; continue only non-overlapping Todo work, coordination, or integration preparation, then synthesize and independently verify after the result returns.",
				"Editing assignments must still name non-overlapping owned files or globs. Use workspace=worktree to isolate ordinary Git paths and enable explicit integrate/discard; it is not a security sandbox or runtime lock and does not intercept absolute-path writes. Use workspace=shared only for intentional read-only or manually coordinated work.",
				"A teammate becoming idle does not release its assignment lease. Structured terminal receipts arrive through send_message and external activation; do not poll status for completion. Use action=interrupt when active work must be cancelled and replaced. An urgent send alone does not preempt a running tool.",
				"For worktree teammates, integrate only after the assignment and teammate process are terminal; request stop and let its terminal event arrive first. Parent verification remains independent. discard requires confirm=true. The parent stops children automatically when its runtime shuts down but preserves every unintegrated worktree and receipt.",
			],
			parameters: teammateAgentSchema,
			execute: (_toolCallId, params, signal, _onUpdate, ctx) => this.execute(params, signal, ctx),
		};
	}

	/** Human-only UI boundary. This is intentionally absent from the teammate_agent tool schema. */
	async startHumanSideHandoff(
		request: HumanSideHandoffRequest,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<HumanSideHandoffResult> {
		if (request.confirmed !== true) throw new Error("Side/BTW teammate handoff requires explicit human confirmation");
		if (request.origin !== "side" && request.origin !== "btw") throw new Error("Invalid Side/BTW handoff origin");
		const conversationId = request.conversationId.trim();
		if (!conversationId) throw new Error("Side/BTW teammate handoff requires a conversation id");
		const context = request.context.trim();
		if (!context) throw new Error("Side/BTW teammate handoff requires a non-empty conversation");
		const bounded = truncateModelText(context, HUMAN_HANDOFF_CONTEXT_MAX_BYTES, HUMAN_HANDOFF_SHORTENED_MARKER);
		const prepared: PreparedHumanSideHandoff = {
			handoffId: uuidv7(),
			origin: request.origin,
			conversationId,
			label: request.label.replace(/\s+/g, " ").trim().slice(0, 120) || `${request.origin} handoff`,
			context: bounded.text,
			contextBytes: Buffer.byteLength(bounded.text, "utf8"),
			messageCount: Math.max(0, Math.floor(request.messageCount)),
			originalBytes: Math.max(0, Math.floor(request.originalBytes)),
			truncated: request.truncated || bounded.truncated,
		};
		const started = await this.start(
			{ action: "start", label: prepared.label, workspace: "shared" },
			signal,
			ctx,
			prepared,
		);
		const teammateId = String(started.details.id);
		const event = this.requireEvent(teammateId);
		const bootstrapMessageId = event.humanHandoff?.bootstrapMessageId;
		if (!bootstrapMessageId) throw new Error(`Managed teammate ${teammateId} did not persist its handoff invitation`);
		return {
			handoffId: prepared.handoffId,
			teammateId,
			sessionId: event.sessionId,
			bootstrapMessageId,
			contextBytes: prepared.contextBytes,
			contextTruncated: prepared.truncated,
		};
	}

	async stopAll(): Promise<void> {
		const events = [...this.events.values()];
		await Promise.all(events.filter((event) => event.status === "running").map((event) => this.stopEvent(event)));
		await Promise.allSettled(events.map((event) => this.captureWorktreeReceipt(event)));
		this.monitor.update();
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await this.stopAll();
	}

	private async execute(params: TeammateAgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		if (!this.isEnabled()) {
			throw new Error("teammate_agent is disabled for the current execution profile");
		}
		const internalParams = params as InternalTeammateAgentInput;
		const requestedAction = String(params.action);
		if (requestedAction === "wait") return this.wait(internalParams, signal);
		const action = requestedAction as TeammateAction;
		if (action === "start") return this.start(params, signal, ctx);
		if (action === "status") return this.status(params);
		if (action === "send") return this.send(params, false);
		if (action === "interrupt") return this.interrupt(params, signal);
		if (action === "stop") return this.stop(params, ctx);
		if (action === "resume") return this.resume(params, signal, ctx);
		if (action === "integrate") return this.integrate(params, ctx);
		if (action === "discard") return this.discard(params, ctx);
		throw new Error(`Unsupported teammate_agent action: ${action}`);
	}

	private async start(
		params: TeammateAgentInput,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		humanHandoff?: PreparedHumanSideHandoff,
	) {
		if (this.shuttingDown) throw new Error("teammate_agent controller is shutting down");
		if (signal?.aborted) throw new Error("teammate_agent start cancelled before launch");
		const running = [...this.events.values()].filter((event) => event.status === "running").length;
		if (running >= MAX_TEAMMATES) {
			throw new Error(`Cannot start teammate: ${running} already running and the limit is ${MAX_TEAMMATES}`);
		}

		const logDir = join(this.getAgentDirPath(), "tmp", "teammates");
		await mkdir(logDir, { recursive: true, mode: 0o700 });
		if (this.shuttingDown) throw new Error("teammate_agent controller is shutting down");
		const id = `teammate_${String(this.nextTeammateNumber++).padStart(3, "0")}`;
		const label = params.label?.trim() || id;
		const requestedCwd = await this.resolveTeammateCwd(ctx.cwd, params.cwd);
		const parentSessionId = this.getParentSessionId();
		const workspace = params.workspace ?? "shared";
		const worktree =
			workspace === "worktree"
				? await this.worktrees.provision({ teammateId: id, parentSessionId, requestedCwd })
				: undefined;
		const cwd = worktree?.checkoutCwd ?? requestedCwd;
		if (this.shuttingDown || signal?.aborted) {
			if (worktree) await this.worktrees.discard(worktree, true).catch(() => undefined);
			throw new Error(
				this.shuttingDown
					? "teammate_agent controller is shutting down"
					: "teammate_agent start cancelled before launch",
			);
		}
		const sessionId = this.createSessionId();
		const parentSessionFile = this.getParentSessionFile();
		const tools = sanitizeTools(params.tools);
		const thinking = (params.thinking ?? "medium") as ThinkingLevel;
		const inheritDefaultModel =
			!params.provider && (!params.model || params.model.trim().toLowerCase() === "default");
		const inheritedModel = inheritDefaultModel ? this.getDefaultModel?.() : undefined;
		const provider = params.provider ?? inheritedModel?.provider;
		const model = inheritDefaultModel ? inheritedModel?.model : params.model;

		const sessionManager = SessionManager.create(cwd, this.getParentSessionDir(), {
			id: sessionId,
			parentSession: parentSessionFile,
		});
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Failed to create managed teammate session");
		sessionManager.appendSessionInfo(label);
		sessionManager.appendCustomMessageEntry(
			"magenta-teammate-identity",
			this.identityContext(sessionId, parentSessionId, workspace, worktree),
			false,
			{
				selfSessionId: sessionId,
				parentSessionId,
				managedBy: "teammate_agent",
				workspace,
				...(worktree ? { worktreePath: worktree.checkoutPath, branch: worktree.branch } : {}),
			},
		);
		if (humanHandoff) {
			sessionManager.appendCustomMessageEntry(
				HUMAN_SIDE_HANDOFF_CUSTOM_TYPE,
				this.humanHandoffContext(parentSessionId, humanHandoff),
				false,
				{
					version: 1,
					humanRequested: true,
					parentSessionId,
					...humanHandoffDetails(humanHandoff),
				},
			);
		}
		sessionManager.flush();

		const stamp = timestampForFile();
		const logPath = join(logDir, `${id}-${stamp}.rpc.log`);
		const log = createWriteStream(logPath, { fd: openSync(logPath, "a", 0o600), autoClose: true });
		const args = [
			"--mode",
			"rpc",
			"--session",
			sessionFile,
			"--no-extensions",
			"--tools",
			tools.join(","),
			"--thinking",
			thinking,
		];
		if (provider) args.push("--provider", provider);
		if (model) args.push("--model", model);

		const invocation = this.resolveAgentInvocation(args);
		let child: ChildProcess;
		try {
			child = this.spawnAgent(invocation.command, invocation.args, {
				cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_TEAMMATE_AGENT: "1",
					[ENV_AGENT_DIR]: this.getAgentDirPath(),
					[ENV_PEER_MESSAGE_DB]: this.getPeerMessageDbPath(),
					[ENV_TEAMMATE_PARENT_SESSION_ID]: parentSessionId,
				},
			});
		} catch (error) {
			await new Promise<void>((resolveClose) => log.end(resolveClose));
			await Promise.allSettled([
				rm(sessionFile, { force: true }),
				rm(logPath, { force: true }),
				...(worktree ? [this.worktrees.discard(worktree, true)] : []),
			]);
			throw error;
		}
		const startedAt = Date.now();
		const event: TeammateEvent = {
			id,
			label,
			cwd,
			sessionId,
			sessionFile,
			parentSessionId,
			parentSessionFile,
			tools,
			model,
			provider,
			thinking,
			logPath,
			log,
			child,
			startedAt,
			status: "running",
			activity: "starting",
			lastActivityAt: startedAt,
			activityPhase: "starting",
			generation: 1,
			stopping: false,
			exitCode: null,
			signal: null,
			tail: "",
			pendingRequests: new Map(),
			waiters: [],
			workspace,
			worktree,
			assignments: new Map(),
			nextAssignmentNumber: 1,
			humanHandoff,
		};
		this.events.set(id, event);
		this.monitor.update(ctx);
		log.write(`$ ${invocation.command} ${invocation.args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
		this.attachProcess(event, ctx);

		const onAbort = () => {
			void this.stopEvent(event, ctx);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const state = await this.sendRpc<RpcSessionState>(event, { type: "get_state" }, signal);
			if (state.sessionId !== sessionId) {
				throw new Error(`Teammate RPC opened unexpected session ${state.sessionId}; expected ${sessionId}`);
			}
			if (this.shuttingDown || event.status !== "running" || event.stopping) {
				throw new Error(`Teammate ${event.id} stopped during startup`);
			}
			event.autoCompactEnabled = state.autoCompactionEnabled;
			setActivity(event, state.isStreaming ? "active" : "idle");
			this.monitor.update(ctx);
		} catch (error: unknown) {
			await this.stopEvent(event, ctx);
			if (event.worktree && event.assignments.size === 0) {
				await this.worktrees.discard(event.worktree, true).catch(() => undefined);
			}
			if (event.status !== "failed") {
				event.status = "failed";
				event.error = error instanceof Error ? error.message : String(error);
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		if (humanHandoff) {
			try {
				const invitation = this.sendPeerMessage({
					to: event.sessionId,
					content: this.humanHandoffInvitation(event, humanHandoff),
					urgent: true,
				});
				event.humanHandoff = { ...humanHandoff, bootstrapMessageId: invitation.details.id };
				this.monitor.update(ctx);
			} catch (error) {
				await this.stopEvent(event, ctx);
				event.status = "failed";
				event.error = `Failed to deliver human Side/BTW invitation: ${error instanceof Error ? error.message : String(error)}`;
				throw new Error(event.error);
			}
		}

		let assignmentResult: ReturnType<TeammateAgentController["send"]> | undefined;
		if (params.message?.trim()) {
			assignmentResult = this.send({ ...params, teammateId: id }, false);
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Started long-lived managed teammate ${id} (${label})\nSession ID: ${sessionId}\nParent session ID: ${parentSessionId}\nCWD: ${cwd}\nWorkspace: ${workspace}${worktree ? `\nWorktree: ${worktree.checkoutPath}\nBranch: ${worktree.branch}\nCollaboration: ${worktree.collaborationRoot}` : ""}\nTools: ${tools.join(",")}\nSession: ${sessionFile}\nLog: ${logPath}\n${assignmentResult ? "The first assignment was delivered through send_message; its soft lease notice follows." : "No assignment lease is active yet. Successful delivery activates a soft lease: do not duplicate its scope, and idle does not release it. Editing assignments must name non-overlapping owned files or globs."}`,
				},
				...(assignmentResult?.content ?? []),
			],
			details: {
				id,
				status: event.status,
				activity: event.activity,
				sessionId,
				parentSessionId,
				sessionFile,
				logPath,
				assignmentMessageId: assignmentResult?.details?.id,
				assignmentId: assignmentResult?.details?.assignmentId,
				...(event.humanHandoff ? { humanHandoff: humanHandoffDetails(event.humanHandoff) } : {}),
				workspace: this.workspaceDetails(event),
			},
		};
	}

	private async status(params: TeammateAgentInput) {
		if (!params.teammateId) {
			const events = [...this.events.values()];
			const lines = events.map(
				(event) =>
					`${event.id}\t${event.status}\t${event.activity}\t${event.workspace}\t${event.currentAssignmentId ?? "no-assignment"}\t${event.label}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No managed teammates." }],
				details: { events: events.map((event) => this.eventDetails(event)) },
			};
		}
		const event = this.requireEvent(params.teammateId);
		return {
			content: [{ type: "text" as const, text: summarizeEvent(event) }],
			details: this.eventDetails(event),
		};
	}

	private send(params: TeammateAgentInput, forceUrgent: boolean, replacement = false) {
		const event = this.requireRunningEvent(params.teammateId, "send");
		const message = params.message?.trim();
		if (!message) throw new Error("teammate_agent action=send requires a non-empty message");
		const urgent = forceUrgent || params.urgent !== false;
		const assignmentId = `${event.id}:assignment_${event.nextAssignmentNumber++}`;
		const result = this.sendPeerMessage({
			to: event.sessionId,
			content: this.assignmentEnvelope(event, message, assignmentId, replacement),
			urgent,
		});
		const assignment: TeammateAssignment = {
			id: assignmentId,
			messageId: result.details.id,
			status: "active",
			startedAt: Date.now(),
			waiters: [],
		};
		event.assignments.set(assignmentId, assignment);
		event.currentAssignmentId = assignmentId;
		return {
			content: [
				...result.content,
				{
					type: "text" as const,
					text: `Managed teammate: ${event.id} (${event.label})\nSession ID: ${event.sessionId}\nAssignment ID: ${assignmentId}\n${TEAMMATE_LEASE_NOTICE}`,
				},
			],
			details: {
				...result.details,
				teammateId: event.id,
				sessionId: event.sessionId,
				assignmentId,
				assignmentStatus: assignment.status,
			},
		};
	}

	private async interrupt(params: TeammateAgentInput, signal: AbortSignal | undefined) {
		const event = this.requireRunningEvent(params.teammateId, "interrupt");
		const message = params.message?.trim();
		if (!message) throw new Error("teammate_agent action=interrupt requires a non-empty message");
		const generation = event.generation;
		setActivity(event, "interrupting");
		this.monitor.update();
		try {
			await this.sendRpc(event, { type: "abort" }, signal);
			if (event.generation !== generation || event.status !== "running" || event.stopping) {
				throw new Error(`Teammate ${event.id} stopped during interrupt`);
			}
			setActivity(event, "idle");
			const replacedAssignments = [...event.assignments.values()].filter(
				(assignment) => assignment.status === "active",
			);
			for (const assignment of replacedAssignments) this.setAssignmentTerminal(assignment, "cancelled");
			const result = this.send({ ...params, teammateId: event.id }, true, true);
			this.monitor.update();
			return {
				content: [
					{
						type: "text" as const,
						text: `Interrupted ${event.id} (${event.label}), confirmed the prior turn aborted, then created a replacement assignment.`,
					},
					...result.content,
				],
				details: {
					...result.details,
					abortedFirst: true,
					replacedAssignmentIds: replacedAssignments.map((assignment) => assignment.id),
				},
			};
		} finally {
			if (event.generation === generation && event.status === "running" && !event.stopping) {
				setActivity(event, "idle");
				this.monitor.update();
			}
		}
	}

	/** Internal compatibility helper; intentionally absent from the public tool schema. */
	private async wait(params: InternalTeammateAgentInput, signal: AbortSignal | undefined) {
		const event = this.requireEvent(params.teammateId);
		const assignmentId = params.assignmentId ?? event.currentAssignmentId;
		if (!assignmentId) throw new Error(`Teammate ${event.id} has no assignment to wait for`);
		const assignment = event.assignments.get(assignmentId);
		if (!assignment) throw new Error(`Unknown assignment ${assignmentId} for teammate ${event.id}`);
		const timeoutMs = Math.max(0, (params.waitTimeoutSeconds ?? 30) * 1_000);
		let timedOut = false;
		if (assignment.status === "active") {
			timedOut = !(await this.waitForAssignment(assignment, timeoutMs, signal));
		}
		return {
			content: [
				{
					type: "text" as const,
					text: timedOut
						? `Wait timed out; assignment ${assignment.id} is still active.`
						: `Assignment ${assignment.id} is ${assignment.status}. Its soft lease is terminal; synthesize the result and independently verify any integrated changes.`,
				},
			],
			details: {
				teammateId: event.id,
				sessionId: event.sessionId,
				...this.assignmentDetails(assignment),
				timedOut,
			},
		};
	}

	private async resume(params: TeammateAgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		if (!params.teammateId) throw new Error("teammate_agent action=resume requires teammateId");
		if (this.shuttingDown) throw new Error("teammate_agent controller is shutting down");
		if (signal?.aborted) throw new Error("teammate_agent resume cancelled before launch");
		const event = this.requireEvent(params.teammateId);
		if (event.status === "running") {
			if (event.stopping) {
				throw new Error(
					`Cannot resume teammate ${event.id} while shutdown is still in progress; resume after its terminal event.`,
				);
			}
			return {
				content: [{ type: "text" as const, text: `Teammate ${event.id} is already running (${event.activity}).` }],
				details: this.eventDetails(event),
			};
		}
		if (!existsSync(event.sessionFile)) {
			throw new Error(`Cannot resume teammate ${event.id}: saved session is missing at ${event.sessionFile}`);
		}
		const running = [...this.events.values()].filter((candidate) => candidate.status === "running").length;
		if (running >= MAX_TEAMMATES) {
			throw new Error(`Cannot resume teammate: ${running} already running and the limit is ${MAX_TEAMMATES}`);
		}

		const logDir = join(this.getAgentDirPath(), "tmp", "teammates");
		await mkdir(logDir, { recursive: true, mode: 0o700 });
		if (this.shuttingDown) throw new Error("teammate_agent controller is shutting down");
		if (event.worktree) {
			await this.worktrees.reactivate(event.worktree);
			event.receiptPromise = undefined;
		}
		const logPath = join(logDir, `${event.id}-${timestampForFile()}.rpc.log`);
		const log = createWriteStream(logPath, { fd: openSync(logPath, "a", 0o600), autoClose: true });
		const args = this.rpcArgs(event);
		const invocation = this.resolveAgentInvocation(args);
		let child: ChildProcess;
		try {
			child = this.spawnAgent(invocation.command, invocation.args, {
				cwd: event.cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_TEAMMATE_AGENT: "1",
					[ENV_AGENT_DIR]: this.getAgentDirPath(),
					[ENV_PEER_MESSAGE_DB]: this.getPeerMessageDbPath(),
					[ENV_TEAMMATE_PARENT_SESSION_ID]: event.parentSessionId,
				},
			});
		} catch (error) {
			await new Promise<void>((resolveClose) => log.end(resolveClose));
			await rm(logPath, { force: true }).catch(() => undefined);
			if (event.worktree) await this.worktrees.captureReceipt(event.worktree).catch(() => undefined);
			throw error;
		}
		event.child = child;
		event.log = log;
		event.logPath = logPath;
		event.startedAt = Date.now();
		event.endedAt = undefined;
		event.status = "running";
		event.activity = "starting";
		event.activityPhase = "starting";
		event.lastActivityAt = event.startedAt;
		event.lastOutputAt = undefined;
		event.lastProgressAt = undefined;
		event.autoCompactEnabled = undefined;
		event.uiTelemetry = undefined;
		event.uiTelemetryFetchedAt = undefined;
		event.uiTelemetryInFlight = undefined;
		event.generation += 1;
		event.stopping = false;
		event.stopPromise = undefined;
		event.receiptPromise = undefined;
		event.exitCode = null;
		event.signal = null;
		event.error = undefined;
		event.tail = "";
		event.lastOutput = undefined;
		event.pendingRequests = new Map();
		event.waiters = [];
		event.terminalNotificationSent = false;
		log.write(`$ ${invocation.command} ${invocation.args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
		this.attachProcess(event, ctx);
		this.monitor.update(ctx);

		try {
			const state = await this.sendRpc<RpcSessionState>(event, { type: "get_state" }, signal);
			if (state.sessionId !== event.sessionId) {
				throw new Error(`Teammate RPC opened unexpected session ${state.sessionId}; expected ${event.sessionId}`);
			}
			if (this.shuttingDown || event.status !== "running" || event.stopping) {
				throw new Error(`Teammate ${event.id} stopped during resume`);
			}
			event.autoCompactEnabled = state.autoCompactionEnabled;
			setActivity(event, state.isStreaming ? "active" : "idle");
			this.monitor.update(ctx);
		} catch (error) {
			await this.stopEvent(event, ctx);
			throw error;
		}

		const queuedMessages = this.getUnreadPeerMessageCount(event.sessionId);
		if (queuedMessages > 0) {
			this.sendPeerMessage({
				to: event.sessionId,
				content: `[managed teammate resume]\n${queuedMessages} queued mailbox message(s) are waiting. Process them now, report results to ${event.parentSessionId} using send_message, then remain idle.`,
				urgent: true,
			});
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Resumed teammate ${event.id} (${event.label}) with saved session ${event.sessionId}.${queuedMessages > 0 ? ` Woke it to process ${queuedMessages} queued mailbox message(s).` : ""}`,
				},
			],
			details: { ...this.eventDetails(event), queuedMessages },
		};
	}

	private stop(params: TeammateAgentInput, ctx: ExtensionContext) {
		if (!params.teammateId) throw new Error("teammate_agent action=stop requires teammateId");
		const event = this.requireEvent(params.teammateId);
		if (event.status !== "running") {
			return {
				content: [{ type: "text" as const, text: `Teammate ${event.id} is already ${event.status}.` }],
				details: this.eventDetails(event),
			};
		}
		void this.stopEvent(event, ctx).catch((error) => {
			event.error = error instanceof Error ? error.message : String(error);
			this.monitor.update(ctx);
		});
		return {
			content: [
				{
					type: "text" as const,
					text: `Stop requested for teammate ${event.id} (${event.label}). Its terminal process event will arrive asynchronously; the saved session and any worktree changes are preserved.`,
				},
			],
			details: this.eventDetails(event),
		};
	}

	private async integrate(params: TeammateAgentInput, ctx: ExtensionContext) {
		const event = this.requireEvent(params.teammateId);
		if (!event.worktree) throw new Error(`Teammate ${event.id} does not use workspace=worktree`);
		const activeAssignments = [...event.assignments.values()].filter((assignment) => assignment.status === "active");
		if (activeAssignments.length > 0) {
			throw new Error(
				`Cannot integrate while ${activeAssignments.length} assignment(s) remain active: ${activeAssignments.map((assignment) => assignment.id).join(", ")}`,
			);
		}
		if (event.status === "running") {
			throw new Error(
				`Cannot integrate running teammate ${event.id}; request action=stop and integrate after its terminal event.`,
			);
		}
		await this.captureWorktreeReceipt(event);
		const result = await this.worktrees.integrate(event.worktree);
		this.monitor.update(ctx);
		return {
			content: [
				{
					type: "text" as const,
					text: `Teammate ${event.id} integration ${result.status}. ${result.changedFiles.length} changed file(s) were applied to the parent checkout as unstaged changes.${result.cleanupPending ? " Worktree cleanup is pending." : ""}`,
				},
			],
			details: { ...this.eventDetails(event), integration: result },
		};
	}

	private async discard(params: TeammateAgentInput, ctx: ExtensionContext) {
		const event = this.requireEvent(params.teammateId);
		if (!event.worktree) throw new Error(`Teammate ${event.id} does not use workspace=worktree`);
		if (event.status === "running") {
			throw new Error(
				`Cannot discard running teammate ${event.id}; request action=stop and discard after its terminal event.`,
			);
		}
		await this.captureWorktreeReceipt(event);
		await this.worktrees.discard(event.worktree, params.confirm === true);
		this.monitor.update(ctx);
		return {
			content: [
				{
					type: "text" as const,
					text: `Discarded managed worktree for ${event.id}. The manifest and immutable change receipt remain under ${event.worktree.collaborationRoot}.`,
				},
			],
			details: this.eventDetails(event),
		};
	}

	private rpcArgs(event: TeammateEvent): string[] {
		const args = [
			"--mode",
			"rpc",
			"--session",
			event.sessionFile,
			"--no-extensions",
			"--tools",
			event.tools.join(","),
			"--thinking",
			event.thinking,
		];
		if (event.provider) args.push("--provider", event.provider);
		if (event.model) args.push("--model", event.model);
		return args;
	}

	private attachProcess(event: TeammateEvent, ctx?: ExtensionContext): void {
		const child = event.child;
		const log = event.log;
		const generation = event.generation;
		if (child.stdout) {
			event.stopReadingStdout = attachJsonlLineReader(child.stdout, (line) => {
				if (event.generation !== generation) return;
				if (!log.writableEnded && !log.destroyed) log.write(`${line}\n`);
				this.handleRpcLine(event, generation, line, ctx);
			});
		}
		child.stderr?.on("data", (data: Buffer) => {
			if (event.generation !== generation) return;
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(event, data.toString("utf8"));
			this.monitor.update(ctx);
		});
		child.stdin?.on("error", (error) => {
			if (event.generation !== generation || event.stopping) return;
			settleEvent(event, generation, "failed", null, null, `Teammate RPC stdin error: ${error.message}`);
			this.handleProcessTerminal(event, "failed");
			this.monitor.update(ctx);
		});
		child.on("error", (error) => {
			settleEvent(event, generation, "failed", null, null, error.message);
			this.handleProcessTerminal(event, "failed");
			this.monitor.update(ctx);
		});
		child.on("close", (code, closeSignal) => {
			if (event.generation !== generation || event.status !== "running") return;
			const stopping = event.stopping || this.shuttingDown;
			settleEvent(
				event,
				generation,
				stopping ? "stopped" : "failed",
				code,
				closeSignal,
				stopping ? undefined : `Teammate RPC process exited unexpectedly (code=${code} signal=${closeSignal})`,
			);
			this.handleProcessTerminal(event, stopping ? "cancelled" : "failed");
			this.monitor.update(ctx);
		});
	}

	private handleRpcLine(event: TeammateEvent, generation: number, line: string, ctx?: ExtensionContext): void {
		if (event.generation !== generation) return;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(line) as Record<string, unknown>;
		} catch {
			appendTail(event, `${line}\n`);
			this.monitor.update(ctx);
			return;
		}
		if (payload.type === "response" && typeof payload.id === "string") {
			const pending = event.pendingRequests.get(payload.id);
			const activityNeutral = pending?.activityNeutral ?? payload.command === "get_session_stats";
			if (!activityNeutral) event.lastActivityAt = Date.now();
			if (pending) {
				event.pendingRequests.delete(payload.id);
				clearTimeout(pending.timer);
				pending.resolve(payload as unknown as RpcResponse);
			}
			this.monitor.update(ctx);
			return;
		}
		if (payload.type === "tool_execution_end" && payload.toolName === "send_message") {
			const result = payload.result as { details?: Record<string, unknown> } | undefined;
			const details = result?.details;
			const assignmentId = typeof details?.assignmentId === "string" ? details.assignmentId : undefined;
			const terminalStatus = details?.terminalStatus;
			if (
				assignmentId &&
				(terminalStatus === "completed" ||
					terminalStatus === "failed" ||
					terminalStatus === "blocked" ||
					terminalStatus === "cancelled")
			) {
				const assignment = event.assignments.get(assignmentId);
				if (assignment?.status === "active") {
					assignment.terminalMessageId = typeof details?.id === "string" ? details.id : undefined;
					this.setAssignmentTerminal(assignment, terminalStatus);
				}
			}
		}
		event.lastActivityAt = Date.now();
		if (payload.type === "agent_start" && !event.stopping) setActivity(event, "active");
		if (payload.type === "agent_end" && !event.stopping) setActivity(event, "idle");
		if (payload.type === "message_end") {
			const message = payload.message as
				| { role?: string; content?: Array<{ type?: string; text?: string }> }
				| undefined;
			if (message?.role === "assistant") {
				const text = message.content
					?.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n")
					.trim();
				if (text) {
					event.lastOutput = text;
					event.lastOutputAt = Date.now();
					event.lastActivityAt = event.lastOutputAt;
				}
			}
		}
		this.monitor.update(ctx);
	}

	private sendRpc<T = unknown>(
		event: TeammateEvent,
		command: Omit<RpcCommand, "id">,
		signal?: AbortSignal,
	): Promise<T> {
		if (event.status !== "running") return Promise.reject(new Error(`Teammate ${event.id} is ${event.status}`));
		const stdin = event.child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			return Promise.reject(new Error(`Teammate ${event.id} RPC stdin is not writable`));
		}
		if (signal?.aborted) return Promise.reject(new Error(`Teammate ${event.id} RPC command aborted`));
		const requestId = `teammate_req_${this.nextRequestNumber++}`;
		return new Promise<T>((resolveRequest, rejectRequest) => {
			const onAbort = () => {
				const pending = event.pendingRequests.get(requestId);
				if (!pending) return;
				event.pendingRequests.delete(requestId);
				clearTimeout(pending.timer);
				rejectRequest(new Error(`Teammate ${event.id} RPC command aborted`));
			};
			const timer = setTimeout(() => {
				event.pendingRequests.delete(requestId);
				signal?.removeEventListener("abort", onAbort);
				rejectRequest(new Error(`Timeout waiting for teammate ${event.id} RPC response to ${command.type}`));
			}, RPC_TIMEOUT_MS);
			event.pendingRequests.set(requestId, {
				timer,
				activityNeutral: command.type === "get_session_stats",
				resolve: (response) => {
					signal?.removeEventListener("abort", onAbort);
					if (!response.success) {
						rejectRequest(new Error((response as Extract<RpcResponse, { success: false }>).error));
						return;
					}
					resolveRequest((response as { data?: T }).data as T);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					rejectRequest(error);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				stdin.write(serializeJsonLine({ ...command, id: requestId }));
			} catch (error: unknown) {
				const pending = event.pendingRequests.get(requestId);
				event.pendingRequests.delete(requestId);
				clearTimeout(timer);
				pending?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private getUiTelemetry(event: TeammateEvent, onUpdate: () => void): EventUiTelemetry | undefined {
		const cached = event.uiTelemetry;
		if (event.status !== "running") return cached;
		const now = Date.now();
		if (event.uiTelemetryFetchedAt !== undefined && now - event.uiTelemetryFetchedAt < UI_TELEMETRY_TTL_MS) {
			return cached;
		}
		if (event.uiTelemetryInFlight) return cached;

		const generation = event.generation;
		event.uiTelemetryFetchedAt = now;
		const refresh = this.sendRpc<SessionStats>(event, { type: "get_session_stats" })
			.then((stats) => {
				if (event.generation !== generation) return;
				event.uiTelemetry = {
					input: stats.tokens.input,
					output: stats.tokens.output,
					cacheRead: stats.tokens.cacheRead,
					cacheWrite: stats.tokens.cacheWrite,
					cost: stats.cost,
					...(stats.costUnknown ? { costUnknown: true } : {}),
					...(stats.contextUsage
						? {
								contextUsage: {
									percent: stats.contextUsage.percent,
									contextWindow: stats.contextUsage.contextWindow,
								},
							}
						: {}),
					...(event.autoCompactEnabled !== undefined ? { autoCompactEnabled: event.autoCompactEnabled } : {}),
					assistantMessages: stats.assistantMessages,
				};
				try {
					onUpdate();
				} catch {
					// The overlay may have closed before the response arrived.
				}
			})
			.catch(() => {
				// Telemetry is opportunistic and must never disrupt event rendering.
			})
			.finally(() => {
				if (event.generation === generation && event.uiTelemetryInFlight === refresh) {
					event.uiTelemetryInFlight = undefined;
				}
			});
		event.uiTelemetryInFlight = refresh;
		return cached;
	}

	private async stopEvent(event: TeammateEvent, ctx?: ExtensionContext): Promise<void> {
		if (event.status !== "running") {
			await this.captureWorktreeReceipt(event);
			return;
		}
		if (event.stopPromise) return event.stopPromise;
		const generation = event.generation;
		event.stopping = true;
		setActivity(event, "stopping");
		this.monitor.update(ctx);
		event.stopPromise = (async () => {
			try {
				await this.sendRpc(event, { type: "abort" });
			} catch {
				// If RPC is already unavailable, continue with transport shutdown.
			}
			if (event.generation !== generation || event.status !== "running") return;
			try {
				event.child.stdin?.end();
			} catch {
				// Fall through to signal-based shutdown.
			}
			if (await waitForExit(event, GRACEFUL_STOP_MS)) return;
			killProcessGroup(event, "SIGTERM");
			if (await waitForExit(event, TERM_GRACE_MS)) return;
			killProcessGroup(event, "SIGKILL");
			if (!(await waitForExit(event, 250))) {
				settleEvent(
					event,
					generation,
					"stopped",
					null,
					"SIGKILL",
					"Teammate process did not report exit after SIGKILL",
				);
				this.handleProcessTerminal(event, "cancelled");
				this.monitor.update(ctx);
			}
		})().finally(async () => {
			await this.captureWorktreeReceipt(event);
		});
		return event.stopPromise;
	}

	private setAssignmentTerminal(
		assignment: TeammateAssignment,
		status: Exclude<TeammateAssignmentStatus, "active">,
	): void {
		if (assignment.status !== "active") return;
		assignment.status = status;
		assignment.completedAt = Date.now();
		for (const resolveWaiter of assignment.waiters.splice(0)) resolveWaiter();
	}

	private handleProcessTerminal(
		event: TeammateEvent,
		status: Exclude<TeammateAssignmentStatus, "active" | "completed" | "blocked">,
	): void {
		for (const assignment of event.assignments.values()) {
			if (assignment.status === "active") this.setAssignmentTerminal(assignment, status);
		}
		void this.captureWorktreeReceipt(event).catch(() => undefined);
		if (this.shuttingDown || event.terminalNotificationSent) return;
		event.terminalNotificationSent = true;
		const assignments = [...event.assignments.values()]
			.map((assignment) => `${assignment.id}:${assignment.status}`)
			.join(", ");
		try {
			this.sendPeerMessage({
				to: event.parentSessionId,
				content: `[managed teammate terminal]\n${event.id} (${event.label}) is ${event.status}. Process status: ${status}.${assignments ? ` Assignments: ${assignments}.` : ""} Session remains saved at ${event.sessionFile}.`,
				urgent: true,
			});
		} catch (error) {
			event.error = [
				event.error,
				`Failed to deliver terminal notification: ${error instanceof Error ? error.message : String(error)}`,
			]
				.filter(Boolean)
				.join("; ");
		}
	}

	private async captureWorktreeReceipt(event: TeammateEvent): Promise<TeammateChangeReceipt | undefined> {
		if (!event.worktree) return undefined;
		if (event.worktree.state === "integrated" || event.worktree.state === "discarded") {
			return event.worktree.receipt;
		}
		if (event.status === "running") return undefined;
		if (!event.receiptPromise) {
			event.receiptPromise = this.worktrees.captureReceipt(event.worktree);
		}
		return event.receiptPromise;
	}

	private waitForAssignment(
		assignment: TeammateAssignment,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (assignment.status !== "active") return Promise.resolve(true);
		if (signal?.aborted || timeoutMs === 0) return Promise.resolve(false);
		return new Promise<boolean>((resolveWait) => {
			let settled = false;
			let waiter: () => void;
			const finish = (terminal: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const index = assignment.waiters.indexOf(waiter);
				if (index >= 0) assignment.waiters.splice(index, 1);
				resolveWait(terminal);
			};
			waiter = () => finish(true);
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), timeoutMs);
			assignment.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private assignmentDetails(assignment: TeammateAssignment): Record<string, unknown> {
		return {
			assignmentId: assignment.id,
			assignmentStatus: assignment.status,
			assignmentMessageId: assignment.messageId,
			assignmentStartedAt: assignment.startedAt,
			assignmentCompletedAt: assignment.completedAt,
			terminalMessageId: assignment.terminalMessageId,
		};
	}

	private workspaceDetails(event: TeammateEvent): Record<string, unknown> {
		if (!event.worktree) return { isolation: "shared", path: event.cwd };
		return {
			isolation: "worktree",
			path: event.worktree.checkoutPath,
			cwd: event.worktree.checkoutCwd,
			repoRoot: event.worktree.repoRoot,
			branch: event.worktree.branch,
			baseCommit: event.worktree.baseCommit,
			state: event.worktree.state,
			collaborationRoot: event.worktree.collaborationRoot,
			manifestPath: event.worktree.manifestPath,
			...(event.worktree.receipt
				? {
						receipt: {
							patchPath: event.worktree.receipt.patchPath,
							patchSha256: event.worktree.receipt.patchSha256,
							patchBytes: event.worktree.receipt.patchBytes,
							changedFiles: event.worktree.receipt.changedFiles,
							insertions: event.worktree.receipt.insertions,
							deletions: event.worktree.receipt.deletions,
						},
					}
				: {}),
		};
	}

	private requireEvent(id: string | undefined): TeammateEvent {
		if (!id) throw new Error("teammateId is required");
		const event = this.events.get(id);
		if (!event) throw new Error(`Unknown teammate: ${id}`);
		return event;
	}

	private requireRunningEvent(id: string | undefined, action: string): TeammateEvent {
		const event = this.requireEvent(id);
		if (event.status !== "running") throw new Error(`Cannot ${action}: teammate ${event.id} is ${event.status}`);
		if (event.stopping) throw new Error(`Cannot ${action}: teammate ${event.id} is stopping`);
		return event;
	}

	private async resolveTeammateCwd(parentCwd: string, requestedCwd: string | undefined): Promise<string> {
		const parentRealpath = await realpath(parentCwd);
		const candidate = resolve(parentCwd, requestedCwd ?? ".");
		let candidateRealpath: string;
		try {
			candidateRealpath = await realpath(candidate);
		} catch {
			throw new Error(`Teammate working directory does not exist: ${candidate}`);
		}
		const candidateStat = await stat(candidateRealpath);
		if (!candidateStat.isDirectory()) throw new Error(`Teammate working directory is not a directory: ${candidate}`);
		const fromParent = relative(parentRealpath, candidateRealpath);
		if (
			fromParent === ".." ||
			fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(fromParent)
		) {
			throw new Error(`Teammate working directory must stay within the main workspace: ${parentRealpath}`);
		}
		return candidateRealpath;
	}

	private humanHandoffContext(parentSessionId: string, handoff: PreparedHumanSideHandoff): string {
		return `# Human-approved Side/BTW handoff

A human explicitly chose to enqueue this ${handoff.origin} conversation as a managed teammate. This transcript is background for an invitation, not a work assignment or ownership lease.

- handoffId: ${handoff.handoffId}
- originConversationId: ${handoff.conversationId}
- parentSessionId: ${parentSessionId}
- messageCount: ${handoff.messageCount}
- originalBytes: ${handoff.originalBytes}
- contextBytes: ${handoff.contextBytes}
- contextTruncated: ${handoff.truncated}

<side-chat-transcript>
${handoff.context}
</side-chat-transcript>`;
	}

	private humanHandoffInvitation(event: TeammateEvent, handoff: PreparedHumanSideHandoff): string {
		return `[human-approved Side/BTW teammate invitation]
handoffId: ${handoff.handoffId}
origin: ${handoff.origin}
originConversationId: ${handoff.conversationId}
managedTeammateId: ${event.id}
selfSessionId: ${event.sessionId}
parentSessionId: ${event.parentSessionId}
replyTargetSessionId: ${event.parentSessionId}

A human explicitly requested this promotion. Read the saved hidden Side/BTW transcript, but do not execute the proposed task, edit files, or claim an assignment yet. This invitation has no assignmentId and creates no ownership lease.

Use send_message now to send one concise plain message to ${event.parentSessionId}. Include managedTeammateId ${event.id}, state that the human requested this Side/BTW handoff, summarize what you believe you could help with, and ask the main agent to discuss and formally dispatch a task. Omit assignmentId and terminalStatus. Then finish this turn and remain idle.`;
	}

	private identityContext(
		selfSessionId: string,
		parentSessionId: string,
		workspace: "shared" | "worktree",
		worktree?: TeammateWorktreeRecord,
	): string {
		return `# Managed teammate identity

You are a long-lived hidden ${APP_NAME} child session managed by the current parent runtime. Your saved context is retained across its assignments, and the parent stops your process when it shuts down.

- selfSessionId: ${selfSessionId}
- parentSessionId: ${parentSessionId}
- replyTargetSessionId: ${parentSessionId}
- workspace: ${workspace}${worktree ? `\n- managedWorktree: ${worktree.checkoutPath}\n- managedBranch: ${worktree.branch}` : ""}

Operating contract:
- A human-approved Side/BTW invitation may arrive without assignmentId. For that invitation, discuss and request dispatch only; do not execute or claim ownership.
- Work assignments arrive as peer messages through send_message.
- Each formal assignment is a soft lease on its stated scope. Stay within that scope; idle does not release it.
- For editing work, the assignment must explicitly name owned non-overlapping files or globs. If it does not, do not edit; report the ambiguity to the parent.
- ${workspace === "worktree" ? `Make every repository edit inside managedWorktree. Git worktree isolation prevents ordinary parent/worker path conflicts, but it is not a security sandbox and does not intercept absolute-path writes.` : `This shared workspace lease is a coordination rule, not a runtime file lock or bash interception.`}
- Complete each assignment independently, then report exactly one structured terminal receipt to replyTargetSessionId using send_message with the supplied assignmentId and terminalStatus; public peer messages are urgent and wake an idle parent.
- Always distinguish selfSessionId from parentSessionId; never infer or swap these identities.
- Do not address the end user directly and do not ask the user questions.
- After reporting, finish the current turn and remain idle for another assignment.
- Do not spawn sub-agents, background shells, or additional teammates.`;
	}

	private assignmentEnvelope(
		event: TeammateEvent,
		message: string,
		assignmentId: string,
		replacement = false,
	): string {
		return `[managed teammate ${replacement ? "replacement instruction" : "assignment"}]
selfSessionId: ${event.sessionId}
parentSessionId: ${event.parentSessionId}
replyTargetSessionId: ${event.parentSessionId}
assignmentId: ${assignmentId}
workspace: ${event.workspace}${event.worktree ? `\nmanagedWorktree: ${event.worktree.checkoutPath}` : ""}

${message}

Ownership contract:
- This delivered assignment creates a soft lease on its stated scope; stay within it until you report a terminal result.
- If editing, proceed only when the assignment explicitly names owned non-overlapping files or globs.
- ${event.worktree ? `Make repository edits only inside managedWorktree. This is Git conflict isolation, not a security sandbox.` : `The shared-workspace lease is coordination, not a runtime lock or bash interception.`}

Report exactly one terminal result with:
send_message({ to: "${event.parentSessionId}", content: "<scope, result, tests, changed files>", assignmentId: "${assignmentId}", terminalStatus: "completed" | "failed" | "blocked" | "cancelled" })
Then finish this turn and remain available.`;
	}

	private eventDetails(event: TeammateEvent): Record<string, unknown> {
		const assignment = event.currentAssignmentId ? event.assignments.get(event.currentAssignmentId) : undefined;
		return {
			id: event.id,
			status: event.status,
			processStatus: event.status,
			activity: event.activity,
			sessionId: event.sessionId,
			parentSessionId: event.parentSessionId,
			sessionFile: event.sessionFile,
			logPath: event.logPath,
			exitCode: event.exitCode,
			signal: event.signal,
			...(assignment ? this.assignmentDetails(assignment) : {}),
			assignments: [...event.assignments.values()].map((candidate) => this.assignmentDetails(candidate)),
			...(event.humanHandoff ? { humanHandoff: humanHandoffDetails(event.humanHandoff) } : {}),
			workspace: this.workspaceDetails(event),
		};
	}
}
