import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createWriteStream, existsSync, openSync, type WriteStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { uuidv7 } from "@magenta/harness";
import { type Static, Type } from "typebox";
import {
	APP_BINARY_NAME,
	APP_NAME,
	ENV_AGENT_DIR,
	ENV_PEER_MESSAGE_DB,
	ENV_TEAMMATE_PARENT_SESSION_ID,
} from "../../config.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState } from "../../modes/rpc/rpc-types.ts";
import type { BackgroundEventManager } from "../background-events.ts";
import {
	appendTail as appendTailText,
	formatDuration,
	timestampForFile,
	truncateTail,
} from "../background-shell-utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import type { PeerMessageDetails, SendMessageInput } from "./send-message.ts";

const MAX_TEAMMATES = 8;
const RPC_TIMEOUT_MS = 30_000;
const GRACEFUL_STOP_MS = 1_000;
const TERM_GRACE_MS = 3_000;
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

type TeammateProcessStatus = "running" | "stopped" | "failed";
type TeammateActivity = "starting" | "idle" | "active" | "interrupting" | "stopping";
type TeammateAction = "start" | "status" | "send" | "interrupt" | "stop" | "resume";

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
		}
	>;
	waiters: Array<() => void>;
};

export type TeammateAgentSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type TeammateAgentModelSelection = {
	provider: string;
	model: string;
};

export type TeammatePeerSend = (params: SendMessageInput) => {
	content: { type: "text"; text: string }[];
	details: PeerMessageDetails;
};

const teammateAgentSchema = Type.Object({
	action: StringEnum(["start", "status", "send", "interrupt", "stop", "resume"] as const),
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
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Tool allowlist for the teammate. send_message is always added; teammate_agent, sub_agent, and bg_shell are always removed.",
		}),
	),
	model: Type.Optional(Type.String({ description: `Optional ${APP_NAME} model pattern or provider/model id.` })),
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
});

export type TeammateAgentInput = Static<typeof teammateAgentSchema>;
export type TeammateAgentDetails = Record<string, unknown>;

function sanitizeTools(requested: string[] | undefined): string[] {
	const selected = requested?.length ? requested : DEFAULT_TOOLS;
	const tools = selected.map((name) => name.trim()).filter((name) => name && !FORBIDDEN_TOOLS.has(name));
	if (!tools.includes("send_message")) tools.push("send_message");
	return [...new Set(tools)];
}

function appendTail(event: TeammateEvent, text: string): void {
	event.tail = appendTailText(event.tail, Buffer.from(text, "utf8"));
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
	private agentCommand: string;
	private getParentSessionId: () => string;
	private getParentSessionFile: () => string | undefined;
	private getParentSessionDir: () => string;
	private getAgentDirPath: () => string;
	private getPeerMessageDbPath: () => string;
	private getDefaultModel?: () => TeammateAgentModelSelection | undefined;
	private createSessionId: () => string;
	private isEnabled: () => boolean;

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
			agentCommand?: string;
			createSessionId?: () => string;
			isEnabled?: () => boolean;
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
		this.agentCommand = options.agentCommand ?? APP_BINARY_NAME;
		this.createSessionId = options.createSessionId ?? uuidv7;
		this.isEnabled = options.isEnabled ?? (() => true);
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
					canCancel: event.status === "running",
				})),
			getEventDetails: (id) => {
				const event = this.events.get(id);
				return event ? summarizeEvent(event).split("\n") : [`unknown teammate event: ${id}`];
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
			description: `Manage persistent hidden ${APP_NAME} teammate sessions. Unlike sub_agent, a teammate has a clean saved session, stays alive across assignments, and communicates through send_message. Use interrupt to abort its current turn before urgently replacing the instruction.`,
			promptSnippet: `Start, message, interrupt, inspect, or stop persistent hidden ${APP_NAME} teammates`,
			promptGuidelines: [
				"Use teammate_agent for a persistent collaborator that should retain its own context across multiple assignments; use sub_agent for disposable one-shot delegation.",
				"All teammate work instructions and results travel through send_message. The RPC channel is control-plane only for state, interrupt, and shutdown.",
				"Use action=interrupt when the current teammate turn must be cancelled and replaced. A merely urgent send steers at a turn boundary but does not preempt a running tool.",
				"Teammates share the working directory by default and may edit files. Assign non-overlapping ownership or request read-only tools when concurrent mutations would conflict.",
				"Stop teammates when their persistent collaboration is no longer needed. They are also stopped automatically when the parent session shuts down.",
			],
			parameters: teammateAgentSchema,
			execute: (_toolCallId, params, signal, _onUpdate, ctx) => this.execute(params, signal, ctx),
		};
	}

	async stopAll(): Promise<void> {
		await Promise.all(
			[...this.events.values()].filter((event) => event.status === "running").map((event) => this.stopEvent(event)),
		);
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
		const action = params.action as TeammateAction;
		if (action === "start") return this.start(params, signal, ctx);
		if (action === "status") return this.status(params);
		if (action === "send") return this.send(params, false);
		if (action === "interrupt") return this.interrupt(params, signal);
		if (action === "stop") return this.stop(params, ctx);
		if (action === "resume") return this.resume(params, signal, ctx);
		throw new Error(`Unsupported teammate_agent action: ${action}`);
	}

	private async start(params: TeammateAgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
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
		const cwd = await this.resolveTeammateCwd(ctx.cwd, params.cwd);
		if (this.shuttingDown) throw new Error("teammate_agent controller is shutting down");
		if (signal?.aborted) throw new Error("teammate_agent start cancelled before launch");
		const sessionId = this.createSessionId();
		const parentSessionId = this.getParentSessionId();
		const parentSessionFile = this.getParentSessionFile();
		const tools = sanitizeTools(params.tools);
		const thinking = (params.thinking ?? "medium") as ThinkingLevel;
		const inheritedModel = !params.provider && !params.model ? this.getDefaultModel?.() : undefined;
		const provider = params.provider ?? inheritedModel?.provider;
		const model = params.model ?? inheritedModel?.model;

		const sessionManager = SessionManager.create(cwd, this.getParentSessionDir(), {
			id: sessionId,
			parentSession: parentSessionFile,
		});
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Failed to create persistent teammate session");
		sessionManager.appendSessionInfo(label);
		sessionManager.appendCustomMessageEntry(
			"magenta-teammate-identity",
			this.identityContext(sessionId, parentSessionId),
			false,
			{ selfSessionId: sessionId, parentSessionId, managedBy: "teammate_agent" },
		);
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

		const child = this.spawnAgent(this.agentCommand, args, {
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
			startedAt: Date.now(),
			status: "running",
			activity: "starting",
			generation: 1,
			stopping: false,
			exitCode: null,
			signal: null,
			tail: "",
			pendingRequests: new Map(),
			waiters: [],
		};
		this.events.set(id, event);
		this.monitor.update(ctx);
		log.write(`$ ${this.agentCommand} ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
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
			event.activity = state.isStreaming ? "active" : "idle";
			this.monitor.update(ctx);
		} catch (error: unknown) {
			await this.stopEvent(event, ctx);
			if (event.status !== "failed") {
				event.status = "failed";
				event.error = error instanceof Error ? error.message : String(error);
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		let assignmentResult: ReturnType<TeammateAgentController["send"]> | undefined;
		if (params.message?.trim()) {
			assignmentResult = this.send({ ...params, teammateId: id }, false);
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Started persistent teammate ${id} (${label})\nSession ID: ${sessionId}\nParent session ID: ${parentSessionId}\nCWD: ${cwd}\nTools: ${tools.join(",")}\nSession: ${sessionFile}\nLog: ${logPath}\n${assignmentResult ? "The first assignment was delivered through send_message." : "The teammate is idle; assign work with action=send."}`,
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
			},
		};
	}

	private status(params: TeammateAgentInput) {
		if (!params.teammateId) {
			const lines = [...this.events.values()].map(
				(event) => `${event.id}\t${event.status}\t${event.activity}\t${event.sessionId}\t${event.label}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No managed teammates." }],
				details: { events: lines.length },
			};
		}
		const event = this.requireEvent(params.teammateId);
		return {
			content: [{ type: "text" as const, text: summarizeEvent(event) }],
			details: this.eventDetails(event),
		};
	}

	private send(params: TeammateAgentInput, forceUrgent: boolean) {
		const event = this.requireRunningEvent(params.teammateId, "send");
		const message = params.message?.trim();
		if (!message) throw new Error("teammate_agent action=send requires a non-empty message");
		const urgent = forceUrgent || params.urgent !== false;
		const result = this.sendPeerMessage({
			to: event.sessionId,
			content: this.assignmentEnvelope(event, message),
			urgent,
		});
		return {
			content: [
				...result.content,
				{
					type: "text" as const,
					text: `Managed teammate: ${event.id} (${event.label})\nSession ID: ${event.sessionId}`,
				},
			],
			details: { ...result.details, teammateId: event.id, sessionId: event.sessionId },
		};
	}

	private async interrupt(params: TeammateAgentInput, signal: AbortSignal | undefined) {
		const event = this.requireRunningEvent(params.teammateId, "interrupt");
		const message = params.message?.trim();
		if (!message) throw new Error("teammate_agent action=interrupt requires a non-empty message");
		const generation = event.generation;
		event.activity = "interrupting";
		this.monitor.update();
		try {
			await this.sendRpc(event, { type: "abort" }, signal);
			if (event.generation !== generation || event.status !== "running" || event.stopping) {
				throw new Error(`Teammate ${event.id} stopped during interrupt`);
			}
			event.activity = "idle";
			const result = this.sendPeerMessage({
				to: event.sessionId,
				content: this.assignmentEnvelope(event, message, true),
				urgent: true,
			});
			this.monitor.update();
			return {
				content: [
					{
						type: "text" as const,
						text: `Interrupted ${event.id} (${event.label}), waited for its active turn to abort, then sent the replacement instruction urgently.`,
					},
					...result.content,
				],
				details: { ...result.details, teammateId: event.id, sessionId: event.sessionId, abortedFirst: true },
			};
		} finally {
			if (event.generation === generation && event.status === "running" && !event.stopping) {
				event.activity = "idle";
				this.monitor.update();
			}
		}
	}

	private async resume(params: TeammateAgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		if (!params.teammateId) throw new Error("teammate_agent action=resume requires teammateId");
		if (this.shuttingDown) throw new Error("teammate_agent controller is shutting down");
		if (signal?.aborted) throw new Error("teammate_agent resume cancelled before launch");
		const event = this.requireEvent(params.teammateId);
		if (event.status === "running") {
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
		const logPath = join(logDir, `${event.id}-${timestampForFile()}.rpc.log`);
		const log = createWriteStream(logPath, { fd: openSync(logPath, "a", 0o600), autoClose: true });
		const args = this.rpcArgs(event);
		const child = this.spawnAgent(this.agentCommand, args, {
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
		event.child = child;
		event.log = log;
		event.logPath = logPath;
		event.startedAt = Date.now();
		event.endedAt = undefined;
		event.status = "running";
		event.activity = "starting";
		event.generation += 1;
		event.stopping = false;
		event.stopPromise = undefined;
		event.exitCode = null;
		event.signal = null;
		event.error = undefined;
		event.tail = "";
		event.lastOutput = undefined;
		event.pendingRequests = new Map();
		event.waiters = [];
		log.write(`$ ${this.agentCommand} ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
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
			event.activity = state.isStreaming ? "active" : "idle";
			this.monitor.update(ctx);
		} catch (error) {
			await this.stopEvent(event, ctx);
			throw error;
		}

		const queuedMessages = this.getUnreadPeerMessageCount(event.sessionId);
		if (queuedMessages > 0) {
			this.sendPeerMessage({
				to: event.sessionId,
				content: `[managed teammate resume]\n${queuedMessages} queued mailbox message(s) are waiting. Process them now, report results to ${event.parentSessionId} with urgent=true, then remain idle.`,
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

	private async stop(params: TeammateAgentInput, ctx: ExtensionContext) {
		if (!params.teammateId) throw new Error("teammate_agent action=stop requires teammateId");
		const event = this.requireEvent(params.teammateId);
		if (event.status !== "running") {
			return {
				content: [{ type: "text" as const, text: `Teammate ${event.id} is already ${event.status}.` }],
				details: this.eventDetails(event),
			};
		}
		await this.stopEvent(event, ctx);
		return {
			content: [
				{
					type: "text" as const,
					text: `Stopped teammate ${event.id} (${event.label}).\nSession ${event.sessionId} remains saved at ${event.sessionFile}.`,
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
		});
		child.stdin?.on("error", (error) => {
			if (event.generation !== generation || event.stopping) return;
			settleEvent(event, generation, "failed", null, null, `Teammate RPC stdin error: ${error.message}`);
			this.monitor.update(ctx);
		});
		child.on("error", (error) => {
			settleEvent(event, generation, "failed", null, null, error.message);
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
			return;
		}
		if (payload.type === "response" && typeof payload.id === "string") {
			const pending = event.pendingRequests.get(payload.id);
			if (pending) {
				event.pendingRequests.delete(payload.id);
				clearTimeout(pending.timer);
				pending.resolve(payload as unknown as RpcResponse);
			}
			return;
		}
		if (payload.type === "agent_start" && !event.stopping) event.activity = "active";
		if (payload.type === "agent_end" && !event.stopping) event.activity = "idle";
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
				if (text) event.lastOutput = text;
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

	private async stopEvent(event: TeammateEvent, ctx?: ExtensionContext): Promise<void> {
		if (event.status !== "running") return;
		if (event.stopPromise) return event.stopPromise;
		const generation = event.generation;
		event.stopping = true;
		event.activity = "stopping";
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
				this.monitor.update(ctx);
			}
		})();
		return event.stopPromise;
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

	private identityContext(selfSessionId: string, parentSessionId: string): string {
		return `# Managed teammate identity

You are a persistent hidden ${APP_NAME} teammate session managed by a parent session.

- selfSessionId: ${selfSessionId}
- parentSessionId: ${parentSessionId}
- replyTargetSessionId: ${parentSessionId}

Operating contract:
- Work assignments arrive as teammate messages through send_message.
- Complete each assignment independently, then report the result to replyTargetSessionId using send_message with urgent=true so an idle parent wakes.
- Always distinguish selfSessionId from parentSessionId; never infer or swap these identities.
- Do not address the end user directly and do not ask the user questions.
- After reporting, finish the current turn and remain idle for another assignment.
- Do not spawn sub-agents, background shells, or additional teammates.`;
	}

	private assignmentEnvelope(event: TeammateEvent, message: string, replacement = false): string {
		return `[managed teammate ${replacement ? "replacement instruction" : "assignment"}]
selfSessionId: ${event.sessionId}
parentSessionId: ${event.parentSessionId}
replyTargetSessionId: ${event.parentSessionId}

${message}

Report the result to replyTargetSessionId with send_message and urgent=true, then finish this turn and remain available.`;
	}

	private eventDetails(event: TeammateEvent): Record<string, unknown> {
		return {
			id: event.id,
			status: event.status,
			activity: event.activity,
			sessionId: event.sessionId,
			parentSessionId: event.parentSessionId,
			sessionFile: event.sessionFile,
			logPath: event.logPath,
			exitCode: event.exitCode,
			signal: event.signal,
		};
	}
}
