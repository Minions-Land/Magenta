import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import {
	BufferedBoundedLog,
	cleanupLogTree,
	DEFAULT_LOG_MAX_AGE_MS,
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_MAX_FILES,
	DEFAULT_LOG_MAX_TOTAL_BYTES,
} from "../../../_magenta/log-retention.ts";
import { uuidv7 } from "../../../_magenta/session/pi/uuid.ts";
import { validateNodeTimeoutMs } from "../../../_magenta/timeout.ts";
import type { MailboxSupport } from "../../send-message/magenta/runtime.ts";
import { MAX_PEER_MESSAGE_CONTENT_BYTES } from "../../send-message/magenta/send-message.ts";
import { ToolExecutionError } from "../../tool-error.ts";
import { appendTail, timestampForFile, truncateModelText } from "./background-utils.ts";
import { DurableMultiagentRegistry, type MultiagentRecord, type ObservedProcessState } from "./registry.ts";
import {
	type TeammateChangeReceipt,
	type TeammateIntegrationResult,
	TeammateWorktreeManager,
	type TeammateWorktreeRecord,
} from "./worktree.ts";

const MAX_RUNNING_TEAMMATES = 16;
/** Response deadline for one RPC command; this does not cap persistent Session lifetime. */
export const DEFAULT_MULTIAGENT_RPC_TIMEOUT_MS = 5 * 60_000;
const GRACEFUL_STOP_MS = 1_000;
const TERM_GRACE_MS = 3_000;
const MAX_TAIL_BYTES = 64 * 1024;
const DEFAULT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"sub_agent",
	"send_message",
	"todo",
	"show",
	"grep",
	"find",
	"ls",
	"web-search",
	"web-fetch",
];
const MANDATORY_TOOLS = ["sub_agent", "send_message", "todo"];
const FORBIDDEN_TOOLS = new Set(["multiagent", "bg_shell"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const IDENTITY_CUSTOM_TYPE = "magenta-multiagent-identity.v1";
export const MAIN_TODO_SESSION_FILE_ENV = "MAGENTA_MAIN_TODO_SESSION_FILE";
const ACTIVE_MULTIAGENT_LOG_PATHS = new Set<string>();

export type MultiagentSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type MultiagentInvocationResolver = (args: string[]) => { command: string; args: string[] };
export type MultiagentModelSelection = { provider: string; model: string };
export type MultiagentHostContext = { cwd: string };
export type MultiagentBackgroundPort = {
	registerSource(source: {
		id: string;
		title: string;
		getEvents: () => Array<Record<string, unknown>>;
		getEventDetails?: (id: string) => string[];
		cancelEvent?: (id: string, context?: MultiagentHostContext) => boolean;
	}): { update: (context?: MultiagentHostContext) => void; dispose?: () => void };
};
export type CreateChildSessionRequest = {
	sessionId: string;
	cwd: string;
	parentSessionFile?: string;
	label: string;
	identityCustomType: typeof IDENTITY_CUSTOM_TYPE;
	identityContent: string;
	identityDetails: Record<string, unknown>;
};
export type CreateChildSession = (request: CreateChildSessionRequest) => Promise<{ sessionFile: string }>;

export type MultiagentRuntimeSettings = {
	cwd: string;
	agentDir: string;
	peerMessageDbPath: string;
	registryPath: string;
	parentSessionId: string;
	parentSessionFile?: string;
	backgroundEvents: MultiagentBackgroundPort;
	resolveAgentInvocation: MultiagentInvocationResolver;
	createChildSession: CreateChildSession;
	getMailboxSupport: () => MailboxSupport;
	getDefaultModel?: () => MultiagentModelSelection | undefined;
	/** Per-command RPC response deadline. Omit for the 5-minute default; does not limit Session lifetime. */
	rpcTimeoutMs?: number;
	/** Override the per-RPC diagnostic log cap for embedders/tests. */
	maxLogBytes?: number;
	spawnAgent?: MultiagentSpawn;
	createSessionId?: () => string;
	worktreeManager?: TeammateWorktreeManager;
	enabled?: () => boolean;
	onRuntime?: (runtime: MultiagentController) => void;
};

const multiagentSchema = Type.Object(
	{
		action: StringEnum(["start", "status", "interrupt", "stop", "resume", "integrate", "discard"] as const),
		sessionId: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Persistent teammate Session id for action=status/interrupt/stop/resume/integrate/discard. NOT used for action=start, which generates and returns a new sessionId.",
			}),
		),
		label: Type.Optional(
			Type.String({ minLength: 1, maxLength: 200, description: "Human-readable label for action=start." }),
		),
		cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory for action=start." })),
		workspace: Type.Optional(
			StringEnum(["shared", "worktree"] as const, {
				description:
					"Workspace mode for action=start. 'shared' uses the main working directory; 'worktree' creates an isolated Git worktree.",
			}),
		),
		tools: Type.Optional(
			Type.Array(
				Type.String({
					minLength: 1,
					maxLength: 100,
					description: "Tool name for action=start. Specifies which tools the teammate can use.",
				}),
				{
					maxItems: 64,
				},
			),
		),
		model: Type.Optional(
			Type.String({ description: "Optional model pattern or provider/model id for action=start." }),
		),
		provider: Type.Optional(Type.String({ description: "Optional provider for action=start." })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level for action=start." })),
		message: Type.Optional(
			Type.String({ description: "Optional bootstrap prompt for start or replacement prompt for interrupt." }),
		),
		confirm: Type.Optional(Type.Boolean({ description: "Required as true for discard." })),
	},
	{ additionalProperties: false },
);

export type MultiagentInput = Static<typeof multiagentSchema>;
export type MultiagentDetails = Record<string, unknown>;
export type HumanMultiagentHandoffRequest = {
	confirmed: true;
	origin: "side" | "btw";
	conversationId: string;
	label: string;
	context: string;
	messageCount: number;
	originalBytes: number;
	truncated: boolean;
};
export type HumanMultiagentHandoffResult = { handoffId: string; sessionId: string };

type RpcCommand = { type: "get_state" | "abort" | "shutdown"; id?: string };
type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: Record<string, unknown>;
	error?: string;
};
type PendingRpc = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};
type LiveHandle = {
	child: ChildProcess;
	log: BufferedBoundedLog;
	logClosed: Promise<void>;
	suppressedMessageUpdates: number;
	generation: number;
	pending: Map<string, PendingRpc>;
	stopPromise?: Promise<void>;
	exitPromise: Promise<void>;
	resolveExit: () => void;
	stopReading?: () => void;
};

function sanitizeTools(requested: string[] | undefined): string[] {
	const selected = requested?.length ? requested : DEFAULT_TOOLS;
	const tools = selected.map((name) => name.trim()).filter((name) => name && !FORBIDDEN_TOOLS.has(name));
	for (const mandatory of MANDATORY_TOOLS) if (!tools.includes(mandatory)) tools.push(mandatory);
	return [...new Set(tools)];
}

function normalizeMailboxMessage(value: string | undefined): string | undefined {
	const message = value?.trim();
	if (!message) return undefined;
	const bytes = Buffer.byteLength(message, "utf8");
	if (bytes > MAX_PEER_MESSAGE_CONTENT_BYTES) {
		throw new ToolExecutionError(
			"invalid_arguments",
			`multiagent message is ${bytes} bytes; maximum ${MAX_PEER_MESSAGE_CONTENT_BYTES} bytes`,
		);
	}
	return message;
}

function iso(value: number | undefined): string | undefined {
	return value === undefined ? undefined : new Date(value).toISOString();
}

function isLiveState(state: ObservedProcessState): boolean {
	return (
		state === "starting" ||
		state === "running" ||
		state === "idle" ||
		state === "active" ||
		state === "interrupting" ||
		state === "stopping"
	);
}

function latestWorktree(record: MultiagentRecord): TeammateWorktreeRecord | undefined {
	return record.worktrees.at(-1);
}

function serializeLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The child is already terminal.
		}
	}
}

async function wait(ms: number): Promise<void> {
	await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class MultiagentController {
	private readonly settings: MultiagentRuntimeSettings;
	private readonly registry: DurableMultiagentRegistry;
	private readonly records = new Map<string, MultiagentRecord>();
	private readonly handles = new Map<string, LiveHandle>();
	private readonly queue: string[] = [];
	private readonly worktrees: TeammateWorktreeManager;
	private readonly runtimeId = randomUUID();
	private readonly monitor: { update: (context?: MultiagentHostContext) => void; dispose?: () => void };
	private readonly ready: Promise<void>;
	private readonly maxLogBytes: number;
	private readonly rpcTimeoutMs: number;
	private nextRequestNumber = 1;
	private readonly tasks = new Set<Promise<unknown>>();
	private disposing = false;
	private disposed = false;
	private disposePromise?: Promise<void>;

	constructor(settings: MultiagentRuntimeSettings) {
		this.settings = settings;
		this.rpcTimeoutMs =
			validateNodeTimeoutMs(settings.rpcTimeoutMs, "multiagent rpcTimeoutMs") ?? DEFAULT_MULTIAGENT_RPC_TIMEOUT_MS;
		this.maxLogBytes =
			typeof settings.maxLogBytes === "number" && Number.isFinite(settings.maxLogBytes) && settings.maxLogBytes >= 0
				? settings.maxLogBytes
				: DEFAULT_LOG_MAX_BYTES;
		this.registry = new DurableMultiagentRegistry(settings.registryPath, settings.parentSessionId);
		this.worktrees = settings.worktreeManager ?? new TeammateWorktreeManager();
		for (const record of this.registry.list()) this.records.set(record.sessionId, record);
		this.monitor = settings.backgroundEvents.registerSource({
			id: "multiagent",
			title: "multiagent",
			getEvents: () =>
				[...this.records.values()].map((record) => ({
					id: record.sessionId,
					status: ["starting", "running", "active", "interrupting", "stopping"].includes(
						record.observedProcessState,
					)
						? "running"
						: record.observedProcessState,
					startedAt: record.startedAt ?? record.createdAt,
					endedAt: record.endedAt,
					label: `${record.label} · ${record.observedProcessState}`,
					cwd: record.cwd,
					lastActivityAt: record.updatedAt,
					activityPhase: record.observedProcessState,
					reminderEligible: record.observedProcessState === "active",
					canCancel: isLiveState(record.observedProcessState),
				})),
			getEventDetails: (sessionId) => {
				const record = this.records.get(sessionId);
				return record ? this.summary(record).split("\n") : [`unknown teammate Session: ${sessionId}`];
			},
			cancelEvent: (sessionId) => {
				const record = this.records.get(sessionId);
				if (!record || record.desiredProcessState !== "running") return false;
				this.track(this.requestStop(record));
				return true;
			},
		});
		this.ready = this.initialize();
	}

	private async initialize(): Promise<void> {
		await this.cleanupLogs();
		await this.recoverDesiredState();
	}

	/**
	 * Teammate RPC output is reproducible and may be regenerated from the child
	 * Session. Clean only the explicit log suffix. Exact paths protect streams
	 * opened by this runtime; a foreign runtime's Session directory is protected
	 * only while its recorded child process is still alive, because older log
	 * names do not identify the owning process. The legacy `teammates` namespace
	 * is included because older Magenta versions wrote there.
	 */
	private async cleanupLogs(): Promise<void> {
		const protectedPrefixes = [...this.records.values()]
			.filter(
				(record) =>
					record.parentRuntimeId !== this.runtimeId &&
					record.processPid !== undefined &&
					isProcessAlive(record.processPid),
			)
			.flatMap((record) => [
				join(this.settings.agentDir, "tmp", "multiagent", record.sessionId),
				join(this.settings.agentDir, "tmp", "teammates", record.sessionId),
			]);
		const roots = [
			join(this.settings.agentDir, "tmp", "multiagent"),
			join(this.settings.agentDir, "tmp", "teammates"),
		];
		await Promise.all(
			roots.map((root) =>
				cleanupLogTree({
					root,
					fileFilter: (path) => path.endsWith(".rpc.log"),
					protectedPaths: ACTIVE_MULTIAGENT_LOG_PATHS,
					protectedPrefixes,
					maxAgeMs: DEFAULT_LOG_MAX_AGE_MS,
					maxTotalBytes: DEFAULT_LOG_MAX_TOTAL_BYTES,
					maxFiles: DEFAULT_LOG_MAX_FILES,
				}),
			),
		);
	}

	createToolDefinition(): AgentTool<any, MultiagentDetails> {
		return {
			name: "multiagent",
			label: "Multiagent",
			description:
				"Register and control persistent teammate Sessions by Session id. Lifecycle intent is durable and acknowledged without waiting for process readiness. Ordinary prompts, chat, progress, and soft steering use send_message; interrupt is the trusted hard-abort path.",
			promptSnippet: "Register and control persistent teammate Sessions by Session id",
			promptGuidelines: [
				"Use multiagent for retained context, iterative collaboration, or explicit Git worktree ownership. Use sub_agent for bounded one-shot work.",
				"Use only the returned Session id for lifecycle control. Use send_message for prompts, questions, progress, results, and soft steering; runtime final output is not forwarded automatically.",
				"start, resume, stop, interrupt, integrate, and discard acknowledge durable intent without waiting for process readiness. Inspect status for observed state.",
				"Worktree generations remain isolated until explicit integrate or discard. Integration applies a verified receipt patch; it does not merge, commit, or cherry-pick.",
			],
			parameters: multiagentSchema,
			renderKind: "multiagent-result",
			execute: (_toolCallId, params, signal) => this.executeTracked(params as MultiagentInput, signal),
		} as AgentTool<any, MultiagentDetails>;
	}

	private executeTracked(params: MultiagentInput, signal?: AbortSignal) {
		const task = this.execute(params, signal);
		this.track(task);
		return task;
	}

	private async execute(params: MultiagentInput, signal?: AbortSignal) {
		await this.ready;
		if (this.disposing) throw new ToolExecutionError("invalid_state", "multiagent runtime is disposing");
		if (this.settings.enabled && !this.settings.enabled()) {
			throw new ToolExecutionError("unauthorized", "multiagent is disabled for the current execution profile");
		}
		switch (params.action) {
			case "start":
				return this.start(params, signal);
			case "status":
				return this.status(params.sessionId);
			case "interrupt":
				return this.interrupt(params);
			case "stop":
				return this.stop(params.sessionId);
			case "resume":
				return this.resume(params.sessionId);
			case "integrate":
				return this.integrate(params.sessionId);
			case "discard":
				return this.discard(params.sessionId, params.confirm === true);
		}
	}

	private async start(params: MultiagentInput, signal?: AbortSignal) {
		if (params.sessionId)
			throw new ToolExecutionError("invalid_arguments", "multiagent start does not accept sessionId");
		if (!this.settings.parentSessionFile || !existsSync(this.settings.parentSessionFile)) {
			throw new ToolExecutionError(
				"invalid_state",
				"multiagent requires a persisted Main Session so lineage and read-only Main Todo can be verified",
			);
		}
		if (signal?.aborted) throw new ToolExecutionError("invalid_state", "multiagent start was aborted");
		const requestedCwd = await this.resolveRequestedCwd(params.cwd);
		const sessionId = this.settings.createSessionId?.() ?? uuidv7();
		if (this.records.has(sessionId)) throw new ToolExecutionError("conflict", `Session ${sessionId} already exists`);
		const workspace = params.workspace ?? "shared";
		let worktree: TeammateWorktreeRecord | undefined;
		try {
			if (workspace === "worktree") {
				worktree = await this.worktrees.provision({
					sessionId: sessionId,
					parentSessionId: this.settings.parentSessionId,
					requestedCwd,
					generation: 1,
				});
			}
		} catch (error) {
			throw new ToolExecutionError("conflict", `Could not provision worktree for ${sessionId}`, { cause: error });
		}
		const cwd = worktree?.checkoutCwd ?? requestedCwd;
		const label = params.label?.trim() || sessionId;
		const tools = sanitizeTools(params.tools);
		const inheritDefaultModel =
			!params.provider && (!params.model || params.model.trim().toLowerCase() === "default");
		const inherited = inheritDefaultModel ? this.settings.getDefaultModel?.() : undefined;
		const provider = params.provider ?? inherited?.provider;
		const model = inheritDefaultModel ? inherited?.model : params.model;
		const bootstrapMessage = normalizeMailboxMessage(params.message);
		const now = Date.now();
		const record: MultiagentRecord = {
			schemaVersion: 1,
			parentSessionId: this.settings.parentSessionId,
			parentSessionFile: this.settings.parentSessionFile,
			sessionId,
			label,
			requestedCwd,
			cwd,
			workspace,
			tools,
			model,
			provider,
			thinking: params.thinking ?? "medium",
			desiredProcessState: "running",
			observedProcessState: "queued",
			createdAt: now,
			updatedAt: now,
			queuedAt: now,
			processGeneration: 0,
			pendingBootstrapMessage: bootstrapMessage,
			worktreeGeneration: worktree ? 1 : 0,
			worktrees: worktree ? [worktree] : [],
		};
		try {
			const created = await this.settings.createChildSession({
				sessionId,
				cwd,
				parentSessionFile: this.settings.parentSessionFile,
				label,
				identityCustomType: IDENTITY_CUSTOM_TYPE,
				identityContent: this.identityPrompt(record),
				identityDetails: {
					schemaVersion: 1,
					managedBy: "multiagent",
					selfSessionId: sessionId,
					parentSessionId: this.settings.parentSessionId,
					workspace,
				},
			});
			record.sessionFile = created.sessionFile;
			this.settings.getMailboxSupport().registerOfflineSession(sessionId);
			this.records.set(sessionId, record);
			await this.persist(record);
		} catch (error) {
			this.records.delete(sessionId);
			if (worktree) await this.worktrees.discard(worktree, true).catch(() => undefined);
			throw new ToolExecutionError("storage_error", `Could not durably register teammate Session ${sessionId}`, {
				retryable: true,
				target: sessionId,
				cause: error,
			});
		}
		this.queue.push(sessionId);
		this.monitor.update();
		queueMicrotask(() => this.pumpQueue());
		if (record.pendingBootstrapMessage) queueMicrotask(() => this.track(this.deliverBootstrap(record)));
		return this.ack("start", record, `Registered persistent teammate Session ${sessionId} in queued state.`);
	}

	private status(sessionId?: string) {
		const records = sessionId ? [this.requireRecord(sessionId)] : [...this.records.values()];
		const sorted = records.sort((left, right) => {
			const liveOrder =
				Number(isLiveState(right.observedProcessState)) - Number(isLiveState(left.observedProcessState));
			return liveOrder || right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId);
		});
		return {
			content: [
				{
					type: "text" as const,
					text: sorted.length
						? sorted.map((record) => this.summary(record)).join("\n\n---\n\n")
						: "No persistent teammates.",
				},
			],
			details: {
				schemaVersion: 1,
				action: "status",
				teammates: sorted.map((record) => this.snapshot(record)),
				capacity: this.capacity(),
			},
		};
	}

	private async interrupt(params: MultiagentInput) {
		const record = this.requireTarget(params.sessionId, "interrupt");
		if (!isLiveState(record.observedProcessState) || record.observedProcessState === "stopping") {
			throw new ToolExecutionError(
				"invalid_state",
				`Session ${record.sessionId} is ${record.observedProcessState}`,
				{
					target: record.sessionId,
					currentState: record.observedProcessState,
				},
			);
		}
		record.pendingInterrupt = {
			requestedAt: Date.now(),
			replacementMessage: normalizeMailboxMessage(params.message),
		};
		record.observedProcessState = "interrupting";
		await this.persist(record);
		this.track(this.applyPendingInterrupt(record));
		return this.ack("interrupt", record, `Hard interrupt intent accepted for ${record.sessionId}.`);
	}

	private async stop(sessionId?: string) {
		const record = this.requireTarget(sessionId, "stop");
		if (record.desiredProcessState === "stopped") {
			throw new ToolExecutionError("invalid_state", `Session ${record.sessionId} is already desired-stopped`, {
				target: record.sessionId,
				currentState: record.observedProcessState,
			});
		}
		record.desiredProcessState = "stopped";
		record.pendingInterrupt = undefined;
		const queueIndex = this.queue.indexOf(record.sessionId);
		if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
		if (record.observedProcessState === "queued" || record.observedProcessState === "starting") {
			record.observedProcessState = "stopped";
			record.endedAt = Date.now();
		}
		await this.persist(record);
		if (this.handles.has(record.sessionId)) this.track(this.stopProcess(record, false));
		this.monitor.update();
		return this.ack("stop", record, `Stop intent accepted for ${record.sessionId}.`);
	}

	private async resume(sessionId?: string) {
		const record = this.requireTarget(sessionId, "resume");
		if (record.desiredProcessState === "running" || isLiveState(record.observedProcessState)) {
			throw new ToolExecutionError("invalid_state", `Session ${record.sessionId} is already desired-running`, {
				target: record.sessionId,
				currentState: record.observedProcessState,
			});
		}
		this.validateSessionIdentity(record);
		await this.validateWorktreeIdentity(record);
		await this.prepareWorktreeForResume(record);
		record.desiredProcessState = "running";
		record.observedProcessState = "queued";
		record.queuedAt = Date.now();
		record.endedAt = undefined;
		record.lastError = undefined;
		await this.persist(record);
		this.queue.push(record.sessionId);
		this.monitor.update();
		queueMicrotask(() => this.pumpQueue());
		return this.ack("resume", record, `Resume intent accepted for ${record.sessionId}.`);
	}

	private async integrate(sessionId?: string) {
		const record = this.requireTarget(sessionId, "integrate");
		if (isLiveState(record.observedProcessState) || record.desiredProcessState === "running") {
			throw new ToolExecutionError("invalid_state", `Stop Session ${record.sessionId} before integration`, {
				target: record.sessionId,
				currentState: record.observedProcessState,
			});
		}
		const worktree = latestWorktree(record);
		if (!worktree) throw new ToolExecutionError("invalid_state", `Session ${record.sessionId} has no worktree`);
		await this.captureReceipt(record, worktree);
		let integration: TeammateIntegrationResult;
		try {
			integration = await this.worktrees.integrate(worktree);
			await this.persist(record);
		} catch (error) {
			throw new ToolExecutionError("conflict", `Could not integrate Session ${record.sessionId}`, {
				target: record.sessionId,
				cause: error,
			});
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Integration ${integration.status} for ${record.sessionId}; ${integration.changedFiles.length} file(s) applied as unstaged changes.`,
				},
			],
			details: {
				schemaVersion: 1,
				action: "integrate",
				sessionId: record.sessionId,
				integration,
				teammate: this.snapshot(record),
			},
		};
	}

	private async discard(sessionId: string | undefined, confirmed: boolean) {
		const record = this.requireTarget(sessionId, "discard");
		if (!confirmed) throw new ToolExecutionError("invalid_arguments", "multiagent discard requires confirm=true");
		if (isLiveState(record.observedProcessState) || record.desiredProcessState === "running") {
			throw new ToolExecutionError("invalid_state", `Stop Session ${record.sessionId} before discard`, {
				target: record.sessionId,
				currentState: record.observedProcessState,
			});
		}
		const worktree = latestWorktree(record);
		if (!worktree) throw new ToolExecutionError("invalid_state", `Session ${record.sessionId} has no worktree`);
		await this.captureReceipt(record, worktree);
		try {
			await this.worktrees.discard(worktree, true);
			await this.persist(record);
		} catch (error) {
			throw new ToolExecutionError("conflict", `Could not discard Session ${record.sessionId}`, {
				target: record.sessionId,
				cause: error,
			});
		}
		return this.ack(
			"discard",
			record,
			`Discarded worktree generation ${worktree.generation} for ${record.sessionId}.`,
		);
	}

	private pumpQueue(): void {
		if (this.disposing) return;
		while (
			[...this.records.values()].filter((record) => isLiveState(record.observedProcessState)).length <
			MAX_RUNNING_TEAMMATES
		) {
			const sessionId = this.queue.shift();
			if (!sessionId) return;
			const record = this.records.get(sessionId);
			if (!record || record.desiredProcessState !== "running" || record.observedProcessState !== "queued") continue;
			record.observedProcessState = "starting";
			this.track(this.persist(record).then(() => this.launch(record)));
		}
	}

	private async launch(record: MultiagentRecord): Promise<void> {
		if (this.disposing) {
			record.observedProcessState = "stopped";
			record.endedAt = Date.now();
			await this.persist(record);
			return;
		}
		if (record.desiredProcessState !== "running" || record.observedProcessState !== "starting") return;
		if (!record.sessionFile) {
			await this.failLaunch(record, "Saved child Session file is missing from the registry");
			return;
		}
		try {
			await this.ensureWorktreeActive(record);
			if (record.desiredProcessState !== "running" || record.observedProcessState !== "starting") return;
			await this.cleanupLogs();
			await mkdir(join(this.settings.agentDir, "tmp", "multiagent", record.sessionId), {
				recursive: true,
				mode: 0o700,
			});
			const suffixPath = join(this.settings.agentDir, "tmp", "multiagent", record.sessionId, "trusted-suffix.md");
			await writeFile(suffixPath, this.trustedSuffix(record), { mode: 0o600 });
			const logPath = join(
				this.settings.agentDir,
				"tmp",
				"multiagent",
				record.sessionId,
				`${timestampForFile()}.rpc.log`,
			);
			const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
			const log = new BufferedBoundedLog(logStream, { maxBytes: this.maxLogBytes });
			const logClosed = new Promise<void>((resolveClosed) => {
				logStream.once("close", () => resolveClosed());
				logStream.once("error", () => resolveClosed());
			});
			ACTIVE_MULTIAGENT_LOG_PATHS.add(logPath);
			logStream.once("close", () => ACTIVE_MULTIAGENT_LOG_PATHS.delete(logPath));
			log.onError(() => {});
			const args = [
				"--mode",
				"rpc",
				"--session",
				record.sessionFile,
				"--no-extensions",
				"--tools",
				record.tools.join(","),
				"--thinking",
				record.thinking,
				"--append-system-prompt",
				suffixPath,
			];
			if (record.provider) args.push("--provider", record.provider);
			if (record.model) args.push("--model", record.model);
			const invocation = this.settings.resolveAgentInvocation(args);
			if (this.disposing || record.desiredProcessState !== "running" || record.observedProcessState !== "starting") {
				log.end();
				await logClosed;
				record.observedProcessState = "stopped";
				record.endedAt = Date.now();
				await this.persist(record);
				return;
			}
			const child = (this.settings.spawnAgent ?? spawn)(invocation.command, invocation.args, {
				cwd: record.cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					MAGENTA_CODING_AGENT_DIR: this.settings.agentDir,
					MAGENTA_PEER_MESSAGE_DB: this.settings.peerMessageDbPath,
					// The control plane consumes lifecycle/response events, not token-level
					// partials. The parent-side filter remains for older child binaries.
					MAGENTA_INTERNAL_RPC_SUPPRESS_MESSAGE_UPDATES: "1",
					...(this.settings.parentSessionFile
						? { [MAIN_TODO_SESSION_FILE_ENV]: this.settings.parentSessionFile }
						: {}),
				},
			});
			let resolveExit!: () => void;
			const exitPromise = new Promise<void>((resolvePromise) => {
				resolveExit = resolvePromise;
			});
			const handle: LiveHandle = {
				child,
				log,
				logClosed,
				suppressedMessageUpdates: 0,
				generation: record.processGeneration + 1,
				pending: new Map(),
				exitPromise,
				resolveExit,
			};
			record.processGeneration = handle.generation;
			record.processPid = child.pid;
			record.parentRuntimeId = this.runtimeId;
			record.startedAt = Date.now();
			record.endedAt = undefined;
			record.lastError = undefined;
			this.handles.set(record.sessionId, handle);
			this.attachProcess(record, handle);
			handle.log.write(`$ ${invocation.command} ${invocation.args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
			const state = await this.sendRpc(record, { type: "get_state" });
			if (state.sessionId !== record.sessionId) throw new Error(`RPC opened Session ${String(state.sessionId)}`);
			if (
				this.handles.get(record.sessionId) !== handle ||
				this.disposing ||
				record.desiredProcessState !== "running"
			) {
				return;
			}
			record.observedProcessState = state.isStreaming === true ? "active" : "idle";
			await this.persist(record);
			this.monitor.update();
			if (record.pendingInterrupt) this.track(this.applyPendingInterrupt(record));
			if (record.pendingBootstrapMessage) this.track(this.deliverBootstrap(record));
		} catch (error) {
			const handle = this.handles.get(record.sessionId);
			if (handle) await this.stopLiveHandle(record, handle, true);
			await this.failLaunch(record, error instanceof Error ? error.message : String(error));
		}
	}

	private attachProcess(record: MultiagentRecord, handle: LiveHandle): void {
		const stdout = handle.child.stdout;
		if (stdout) {
			const lines = createInterface({ input: stdout });
			lines.on("line", (line) => {
				if (this.handles.get(record.sessionId) !== handle) return;
				this.handleRpcLine(record, handle, line);
			});
			handle.stopReading = () => lines.close();
		}
		handle.child.stderr?.on("data", (data: Buffer) => {
			if (this.handles.get(record.sessionId) !== handle) return;
			this.flushSuppressedRpcTrace(handle);
			handle.log.write(data);
			const text = appendTail("", data, MAX_TAIL_BYTES);
			record.lastError = text.trim() || record.lastError;
			this.monitor.update();
		});
		const terminal = (error?: string) => {
			if (this.handles.get(record.sessionId) !== handle) return;
			this.track(this.handleProcessTerminal(record, handle, error));
		};
		handle.child.once("error", (error) => terminal(error.message));
		handle.child.once("close", (code, signal) =>
			terminal(
				record.desiredProcessState === "running" && !this.disposing
					? `Teammate process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "none"})`
					: undefined,
			),
		);
	}

	private handleRpcLine(record: MultiagentRecord, handle: LiveHandle, line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			this.flushSuppressedRpcTrace(handle);
			handle.log.write(`${line}\n`);
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			this.flushSuppressedRpcTrace(handle);
			handle.log.write(`${line}\n`);
			return;
		}
		const payload = parsed as Record<string, unknown>;
		if (payload.type === "message_update") {
			handle.suppressedMessageUpdates++;
			return;
		}
		this.flushSuppressedRpcTrace(handle);
		handle.log.write(`${line}\n`);
		if (payload.type === "response" && typeof payload.id === "string") {
			const pending = handle.pending.get(payload.id);
			if (pending) {
				handle.pending.delete(payload.id);
				clearTimeout(pending.timer);
				pending.resolve(payload as RpcResponse);
			}
			return;
		}
		if (payload.type === "turn_start" || payload.type === "agent_start") {
			record.observedProcessState = "active";
			this.track(this.persist(record));
			this.monitor.update();
			return;
		}
		if (payload.type === "agent_end") {
			record.observedProcessState = "idle";
			this.track(this.persist(record));
			this.monitor.update();
		}
	}

	private flushSuppressedRpcTrace(handle: LiveHandle): void {
		const count = handle.suppressedMessageUpdates;
		if (count === 0) return;
		handle.suppressedMessageUpdates = 0;
		handle.log.write(serializeLine({ type: "magenta_rpc_trace_summary", suppressedMessageUpdates: count }));
	}

	private sendRpc(record: MultiagentRecord, command: RpcCommand): Promise<Record<string, unknown>> {
		const handle = this.handles.get(record.sessionId);
		if (!handle) return Promise.reject(new Error(`Session ${record.sessionId} has no live RPC process`));
		const stdin = handle.child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return Promise.reject(new Error("RPC stdin is not writable"));
		const requestId = `multiagent_req_${this.nextRequestNumber++}`;
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				handle.pending.delete(requestId);
				rejectRequest(new Error(`Timeout waiting for ${command.type} response from ${record.sessionId}`));
			}, this.rpcTimeoutMs);
			timer.unref?.();
			handle.pending.set(requestId, {
				timer,
				resolve: (response) => {
					if (!response.success) rejectRequest(new Error(response.error ?? `RPC ${command.type} failed`));
					else resolveRequest(response.data ?? {});
				},
				reject: rejectRequest,
			});
			try {
				stdin.write(serializeLine({ ...command, id: requestId }));
			} catch (error) {
				clearTimeout(timer);
				handle.pending.delete(requestId);
				rejectRequest(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private async applyPendingInterrupt(record: MultiagentRecord): Promise<void> {
		const pending = record.pendingInterrupt;
		if (!pending || !this.handles.has(record.sessionId)) return;
		try {
			this.handles.get(record.sessionId)?.log.flush();
			await this.sendRpc(record, { type: "abort" });
			if (
				record.pendingInterrupt !== pending ||
				record.desiredProcessState !== "running" ||
				!this.handles.has(record.sessionId)
			) {
				return;
			}
			if (pending.replacementMessage) {
				this.settings.getMailboxSupport().send({ to: record.sessionId, content: pending.replacementMessage });
			}
			record.pendingInterrupt = undefined;
			record.observedProcessState = "idle";
			await this.persist(record);
		} catch (error) {
			if (record.pendingInterrupt !== pending || record.desiredProcessState !== "running") return;
			record.lastError = `Interrupt failed: ${error instanceof Error ? error.message : String(error)}`;
			record.observedProcessState = this.handles.has(record.sessionId) ? "running" : "failed";
			await this.persist(record);
		}
		this.monitor.update();
	}

	private async deliverBootstrap(record: MultiagentRecord): Promise<void> {
		const message = record.pendingBootstrapMessage;
		if (!message) return;
		try {
			const result = this.settings.getMailboxSupport().send({ to: record.sessionId, content: message });
			record.bootstrapMessageId = result.details.messageId;
			record.pendingBootstrapMessage = undefined;
			await this.persist(record);
		} catch (error) {
			record.lastError = `Bootstrap mailbox acceptance failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.persist(record);
		}
	}

	private async requestStop(record: MultiagentRecord): Promise<void> {
		if (record.desiredProcessState !== "stopped") {
			record.desiredProcessState = "stopped";
			await this.persist(record);
		}
		await this.stopProcess(record, false);
	}

	private async stopProcess(record: MultiagentRecord, preserveDesired: boolean): Promise<void> {
		if (!preserveDesired) record.desiredProcessState = "stopped";
		const handle = this.handles.get(record.sessionId);
		if (!handle) {
			record.observedProcessState = "stopped";
			record.endedAt = Date.now();
			await this.persist(record);
			return;
		}
		if (handle.stopPromise) return handle.stopPromise;
		record.observedProcessState = "stopping";
		await this.persist(record);
		handle.stopPromise = this.stopLiveHandle(record, handle, false);
		return handle.stopPromise;
	}

	private async stopLiveHandle(record: MultiagentRecord, handle: LiveHandle, launchFailure: boolean): Promise<void> {
		try {
			handle.log.flush();
			await Promise.race([this.sendRpc(record, { type: "abort" }).catch(() => undefined), wait(250)]);
			try {
				handle.child.stdin?.end();
			} catch {
				// Continue with signals.
			}
			await Promise.race([handle.exitPromise, wait(GRACEFUL_STOP_MS)]);
			if (this.handles.get(record.sessionId) === handle) {
				killProcessGroup(handle.child, "SIGTERM");
				await Promise.race([handle.exitPromise, wait(TERM_GRACE_MS)]);
			}
			if (this.handles.get(record.sessionId) === handle) {
				killProcessGroup(handle.child, "SIGKILL");
				await Promise.race([handle.exitPromise, wait(250)]);
			}
		} finally {
			if (this.handles.get(record.sessionId) === handle) {
				await this.handleProcessTerminal(
					record,
					handle,
					launchFailure ? "Process launch/readiness failed" : undefined,
				);
			}
		}
	}

	private async handleProcessTerminal(record: MultiagentRecord, handle: LiveHandle, error?: string): Promise<void> {
		if (this.handles.get(record.sessionId) !== handle) return;
		this.handles.delete(record.sessionId);
		handle.stopReading?.();
		for (const pending of handle.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`Session ${record.sessionId} process terminated`));
		}
		handle.pending.clear();
		this.flushSuppressedRpcTrace(handle);
		handle.log.end();
		await handle.logClosed;
		record.processPid = undefined;
		record.parentRuntimeId = undefined;
		record.endedAt = Date.now();
		record.observedProcessState = record.desiredProcessState === "stopped" || this.disposing ? "stopped" : "failed";
		record.lastError = error ?? record.lastError;
		try {
			const worktree = latestWorktree(record);
			if (worktree && worktree.state === "active")
				await this.captureReceipt(record, worktree).catch(() => undefined);
			await this.persist(record);
		} finally {
			handle.resolveExit();
		}
		this.monitor.update();
		queueMicrotask(() => this.pumpQueue());
	}

	private async failLaunch(record: MultiagentRecord, message: string): Promise<void> {
		record.observedProcessState = record.desiredProcessState === "stopped" ? "stopped" : "failed";
		record.endedAt = Date.now();
		record.lastError = message;
		record.processPid = undefined;
		await this.persist(record);
		this.monitor.update();
		queueMicrotask(() => this.pumpQueue());
	}

	private async recoverDesiredState(): Promise<void> {
		let changed = false;
		for (const record of this.records.values()) {
			if (record.desiredProcessState !== "running") {
				record.observedProcessState = "stopped";
				record.processPid = undefined;
				changed = true;
				continue;
			}
			record.autoResumeAttemptedAt = Date.now();
			try {
				this.validateSessionIdentity(record);
				await this.validateWorktreeIdentity(record);
				await this.fenceStaleProcess(record);
				record.processPid = undefined;
				record.parentRuntimeId = undefined;
				record.observedProcessState = "queued";
				record.queuedAt = Date.now();
				record.lastError = undefined;
				this.queue.push(record.sessionId);
			} catch (error) {
				record.observedProcessState = "failed";
				record.lastError = `Automatic resume validation failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			changed = true;
		}
		if (changed) await this.registry.replace(this.records.values());
		this.monitor.update();
		queueMicrotask(() => this.pumpQueue());
	}

	private validateSessionIdentity(record: MultiagentRecord): void {
		if (!record.sessionFile || !existsSync(record.sessionFile)) throw new Error("saved Session file is missing");
		const lines = readFileSync(record.sessionFile, "utf8").split(/\r?\n/).filter(Boolean);
		const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown> | null;
		if (!header || header.type !== "session" || header.id !== record.sessionId)
			throw new Error("Session header id mismatch");
		if (record.parentSessionId !== this.settings.parentSessionId) throw new Error("Session owner lineage mismatch");
		if (this.settings.parentSessionFile && record.parentSessionFile !== this.settings.parentSessionFile) {
			throw new Error("Main Session file lineage mismatch");
		}
		if (record.parentSessionFile && header.parentSession !== record.parentSessionFile) {
			throw new Error("Session header parent lineage mismatch");
		}
		const identity = lines.slice(1).some((line) => {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const details = entry.details as Record<string, unknown> | undefined;
				return (
					entry.type === "custom_message" &&
					entry.customType === IDENTITY_CUSTOM_TYPE &&
					details?.managedBy === "multiagent" &&
					details.selfSessionId === record.sessionId &&
					details.parentSessionId === record.parentSessionId &&
					details.workspace === record.workspace
				);
			} catch {
				return false;
			}
		});
		if (!identity) throw new Error("managed Session identity record is missing or mismatched");
	}

	private async validateWorktreeIdentity(record: MultiagentRecord): Promise<void> {
		if (record.workspace === "shared") {
			if (record.worktrees.length > 0) throw new Error("shared Session unexpectedly owns worktree records");
			return;
		}
		const worktree = latestWorktree(record);
		if (!worktree) throw new Error("worktree Session is missing its current generation");
		if (
			worktree.sessionId !== record.sessionId ||
			worktree.parentSessionId !== record.parentSessionId ||
			worktree.generation !== record.worktreeGeneration
		) {
			throw new Error("worktree registry lineage mismatch");
		}
		const validated = await this.worktrees.validate(worktree);
		record.worktrees[record.worktrees.length - 1] = validated;
		record.cwd = validated.checkoutCwd;
	}

	private async fenceStaleProcess(record: MultiagentRecord): Promise<void> {
		const pid = record.processPid;
		if (!pid || pid === process.pid) return;
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (process.platform === "win32") throw new Error(`cannot safely fence stale process ${pid} on Windows`);
		const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
		const command = inspected.status === 0 ? inspected.stdout.trim() : "";
		if (!record.sessionFile || !command.includes(record.sessionFile)) {
			throw new Error(`stale pid ${pid} does not match the saved child Session command`);
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			process.kill(pid, "SIGTERM");
		}
		await wait(100);
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The fenced process already exited.
		}
	}

	private async prepareWorktreeForResume(record: MultiagentRecord): Promise<void> {
		if (record.workspace !== "worktree") return;
		const latest = latestWorktree(record);
		if (
			!latest ||
			latest.state === "integrated" ||
			latest.state === "discarded" ||
			latest.state === "cleanup_pending"
		) {
			const generation = record.worktreeGeneration + 1;
			const worktree = await this.worktrees.provision({
				sessionId: record.sessionId,
				parentSessionId: record.parentSessionId,
				requestedCwd: record.requestedCwd,
				generation,
			});
			record.worktreeGeneration = generation;
			record.worktrees.push(worktree);
			record.cwd = worktree.checkoutCwd;
			await this.rebindSessionCwd(record, worktree.checkoutCwd);
			return;
		}
		if (latest.state !== "active") await this.worktrees.reactivate(latest);
		record.cwd = latest.checkoutCwd;
		await this.rebindSessionCwd(record, latest.checkoutCwd);
	}

	private async ensureWorktreeActive(record: MultiagentRecord): Promise<void> {
		if (record.workspace !== "worktree") return;
		const worktree = latestWorktree(record);
		if (!worktree) throw new Error("worktree registry record is missing");
		if (worktree.state === "integrated" || worktree.state === "discarded" || worktree.state === "cleanup_pending") {
			throw new Error(
				`worktree generation ${worktree.generation} is ${worktree.state}; explicit resume must create a new generation`,
			);
		}
		if (worktree.state !== "active") await this.worktrees.reactivate(worktree);
		record.cwd = worktree.checkoutCwd;
	}

	private async rebindSessionCwd(record: MultiagentRecord, cwd: string): Promise<void> {
		if (!record.sessionFile) throw new Error("saved Session file is missing");
		const text = await readFile(record.sessionFile, "utf8");
		const newline = text.indexOf("\n");
		if (newline < 0) throw new Error("saved Session file has no header line");
		const header = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
		if (header.type !== "session" || header.id !== record.sessionId) throw new Error("saved Session header mismatch");
		header.cwd = cwd;
		const temporary = `${record.sessionFile}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(header)}\n${text.slice(newline + 1)}`, { mode: 0o600 });
		await rename(temporary, record.sessionFile);
	}

	private async captureReceipt(
		record: MultiagentRecord,
		worktree: TeammateWorktreeRecord,
	): Promise<TeammateChangeReceipt> {
		try {
			const receipt = await this.worktrees.captureReceipt(worktree);
			await this.persist(record);
			return receipt;
		} catch (error) {
			record.lastError = `Worktree receipt failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.persist(record);
			throw error;
		}
	}

	private async resolveRequestedCwd(input: string | undefined): Promise<string> {
		const candidate = resolve(this.settings.cwd, input ?? ".");
		const resolved = await realpath(candidate).catch(() => undefined);
		if (!resolved)
			throw new ToolExecutionError("invalid_arguments", `Working directory does not exist: ${candidate}`);
		const info = await stat(resolved);
		if (!info.isDirectory())
			throw new ToolExecutionError("invalid_arguments", `Working directory is not a directory: ${resolved}`);
		return resolved;
	}

	private identityPrompt(record: MultiagentRecord): string {
		return [
			"[persistent multiagent identity]",
			`selfSessionId: ${record.sessionId}`,
			`parentSessionId: ${record.parentSessionId}`,
			`workspace: ${record.workspace}`,
			"This retained Session is directly managed by the named parent Main Session.",
		].join("\n");
	}

	private trustedSuffix(record: MultiagentRecord): string {
		return [
			"# Persistent Teammate Contract",
			`Your Session id is ${record.sessionId}. Your Main Session id is ${record.parentSessionId}.`,
			"Use send_message for every cross-Session prompt, progress update, question, blocker, uncertainty, and result. Your final assistant output is not forwarded automatically.",
			"Material progress and terminal results must be sent explicitly to Main with send_message. Do not address the human user directly.",
			"You may use sub_agent for bounded finite delegation. You may not use multiagent or bg_shell.",
			"The todo Tool projects Main's authoritative plan read-only. Use todo get for current state. Send proposed mutations to Main; never create a second plan.",
			"Ordinary mailbox messages are soft steering. Only Main's trusted multiagent interrupt can hard-abort your active turn.",
		].join("\n\n");
	}

	private requireRecord(sessionId: string): MultiagentRecord {
		const record = this.records.get(sessionId);
		if (!record || record.parentSessionId !== this.settings.parentSessionId) {
			throw new ToolExecutionError("not_found", `Unknown managed teammate Session: ${sessionId}`, {
				target: sessionId,
			});
		}
		return record;
	}

	private requireTarget(sessionId: string | undefined, action: string): MultiagentRecord {
		if (!sessionId?.trim())
			throw new ToolExecutionError("invalid_arguments", `multiagent ${action} requires sessionId`);
		return this.requireRecord(sessionId);
	}

	private async persist(record: MultiagentRecord): Promise<void> {
		record.updatedAt = Date.now();
		await this.registry.upsert(record);
	}

	private track(task: Promise<unknown>): void {
		this.tasks.add(task);
		void task.then(
			() => this.tasks.delete(task),
			() => this.tasks.delete(task),
		);
	}

	private capacity() {
		return {
			running: this.handles.size,
			starting: [...this.records.values()].filter((record) => record.observedProcessState === "starting").length,
			limit: MAX_RUNNING_TEAMMATES,
			queued: this.queue.length,
		};
	}

	private snapshot(record: MultiagentRecord) {
		const worktree = latestWorktree(record);
		return {
			sessionId: record.sessionId,
			parentSessionId: record.parentSessionId,
			label: record.label,
			desiredProcessState: record.desiredProcessState,
			observedProcessState: record.observedProcessState,
			createdAt: iso(record.createdAt),
			queuedAt: iso(record.queuedAt),
			startedAt: iso(record.startedAt),
			endedAt: iso(record.endedAt),
			processGeneration: record.processGeneration,
			queuePosition: record.observedProcessState === "queued" ? this.queue.indexOf(record.sessionId) + 1 : undefined,
			mailbox: { unread: this.settings.getMailboxSupport().unreadCountFor(record.sessionId) },
			workspace: {
				mode: record.workspace,
				generation: worktree?.generation,
				state: worktree?.state,
				checkoutPath: worktree?.checkoutPath,
				receipt: worktree?.receipt,
			},
			lastError: record.lastError,
		};
	}

	private summary(record: MultiagentRecord): string {
		const snapshot = this.snapshot(record);
		return truncateModelText(
			[
				`Session: ${record.sessionId} (${record.label})`,
				`Process: desired=${record.desiredProcessState} observed=${record.observedProcessState}`,
				`CWD: ${record.cwd}`,
				`Workspace: ${snapshot.workspace.mode}${snapshot.workspace.generation ? ` generation ${snapshot.workspace.generation} (${snapshot.workspace.state})` : ""}`,
				`Mailbox unread: ${snapshot.mailbox.unread}`,
				...(record.lastError ? [`Error: ${record.lastError}`] : []),
			].join("\n"),
			16 * 1024,
		).text;
	}

	hasLiveWork(): boolean {
		if (this.disposed) return false;
		return [...this.records.values()].some(
			(record) => record.desiredProcessState === "running" || isLiveState(record.observedProcessState),
		);
	}

	async startHumanSideHandoff(request: HumanMultiagentHandoffRequest): Promise<HumanMultiagentHandoffResult> {
		if (this.disposing) throw new ToolExecutionError("invalid_state", "multiagent runtime is disposing");
		if (this.settings.enabled && !this.settings.enabled()) {
			throw new ToolExecutionError("unauthorized", "multiagent is disabled for the current execution profile");
		}
		if (request.confirmed !== true) {
			throw new ToolExecutionError("unauthorized", "Side/BTW multiagent handoff requires explicit confirmation");
		}
		const context = truncateModelText(
			request.context.trim(),
			16 * 1024,
			"\n\n[Side/BTW handoff context shortened at the persistent-Session boundary.]\n\n",
		).text;
		if (!context) throw new ToolExecutionError("invalid_arguments", "Side/BTW handoff context is empty");
		const handoffId = uuidv7();
		const startTask = this.start({
			action: "start",
			label: request.label.trim() || `${request.origin} handoff`,
			workspace: "shared",
			message: [
				`[human ${request.origin} handoff ${handoffId}]`,
				"Use this recent conversation only as background. Send your understanding and any questions to Main with send_message before taking broad action.",
				context,
			].join("\n\n"),
		});
		this.track(startTask);
		const result = await startTask;
		return { handoffId, sessionId: String((result.details as { sessionId: string }).sessionId) };
	}

	private ack(action: string, record: MultiagentRecord, text: string) {
		return {
			content: [{ type: "text" as const, text }],
			details: {
				schemaVersion: 1,
				action,
				sessionId: record.sessionId,
				desiredProcessState: record.desiredProcessState,
				observedProcessState: record.observedProcessState,
				acceptedAt: new Date().toISOString(),
				capacity: this.capacity(),
				teammate: this.snapshot(record),
			},
		};
	}

	dispose(): Promise<void> {
		if (!this.disposePromise) this.disposePromise = this.disposeOwnedResources();
		return this.disposePromise;
	}

	private async disposeOwnedResources(): Promise<void> {
		this.disposing = true;
		await this.ready.catch(() => undefined);
		this.queue.length = 0;
		for (let pass = 0; pass < 3; pass++) {
			await Promise.allSettled(
				[...this.records.values()]
					.filter((record) => this.handles.has(record.sessionId))
					.map((record) => this.stopProcess(record, true)),
			);
			const tasks = [...this.tasks];
			if (tasks.length > 0) await Promise.allSettled(tasks);
			if (this.handles.size === 0 && this.tasks.size === 0) break;
		}
		for (const record of this.records.values()) {
			if (
				record.desiredProcessState === "running" ||
				record.observedProcessState === "queued" ||
				isLiveState(record.observedProcessState)
			) {
				record.observedProcessState = "stopped";
				record.processPid = undefined;
				record.parentRuntimeId = undefined;
				record.endedAt = Date.now();
				record.updatedAt = Date.now();
			}
		}
		await this.registry.replace(this.records.values());
		this.monitor.dispose?.();
		this.disposed = true;
	}
}

export { multiagentSchema };
