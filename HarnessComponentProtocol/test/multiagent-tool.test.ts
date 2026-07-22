import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_MAX_TIMEOUT_MS } from "../_magenta/timeout.ts";
import {
	type CreateChildSessionRequest,
	DEFAULT_MULTIAGENT_RPC_TIMEOUT_MS,
	type MultiagentBackgroundPort,
	MultiagentController,
	type MultiagentSpawn,
} from "../tools/multiagent/magenta/multiagent.ts";
import type { MultiagentRecord } from "../tools/multiagent/magenta/registry.ts";
import type {
	TeammateChangeReceipt,
	TeammateIntegrationResult,
	TeammateWorktreeManager,
	TeammateWorktreeRecord,
} from "../tools/multiagent/magenta/worktree.ts";
import type { MailboxSupport } from "../tools/send-message/magenta/runtime.ts";

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!(await predicate())) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type FakeChild = ChildProcess & {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough;
	kill: ReturnType<typeof vi.fn>;
};
type SpawnRecord = { sessionId: string; command: string; args: string[]; options: SpawnOptions; child: FakeChild };

function createSpawn(
	records: SpawnRecord[],
	options: {
		ready?: boolean;
		closeAfterReady?: boolean;
		deferredAbortResponses?: Array<() => void>;
		onDeferredAbortRequest?: () => void;
	} = {},
): MultiagentSpawn {
	return (command, args, spawnOptions) => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const stdin = new PassThrough();
		const child = new EventEmitter() as FakeChild;
		Object.assign(child, { stdout, stderr, stdin, pid: 80000 + records.length, exitCode: null, signalCode: null });
		let closed = false;
		const close = (code: number | null = 0, signal: NodeJS.Signals | null = null, synchronous = false) => {
			if (closed) return;
			closed = true;
			Object.assign(child, { exitCode: code, signalCode: signal });
			if (synchronous) child.emit("close", code, signal);
			else queueMicrotask(() => child.emit("close", code, signal));
		};
		child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
			close(null, typeof signal === "string" ? signal : "SIGTERM");
			return true;
		});
		const sessionPath = args[args.indexOf("--session") + 1]!;
		const header = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0]!) as { id: string };
		stdin.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
				const request = JSON.parse(line) as { id: string; type: string };
				if (request.type === "get_state" && options.ready === false) continue;
				const response = {
					id: request.id,
					type: "response",
					command: request.type,
					success: true,
					...(request.type === "get_state" ? { data: { sessionId: header.id, isStreaming: false } } : {}),
				};
				const deliver = () => {
					stdout.write(`${JSON.stringify(response)}\n`);
					if (request.type === "get_state" && options.closeAfterReady) close(1, null, true);
				};
				if (request.type === "abort" && options.deferredAbortResponses) {
					options.deferredAbortResponses.push(deliver);
					options.onDeferredAbortRequest?.();
				} else {
					queueMicrotask(deliver);
				}
			}
		});
		stdin.once("finish", () => close(0, null));
		records.push({ sessionId: header.id, command, args, options: spawnOptions, child });
		return child;
	};
}

function createMailbox() {
	const registered = new Set<string>();
	const messages: Array<{ to: string; content: string; messageId: string }> = [];
	const support: MailboxSupport = {
		registerOfflineSession(sessionId) {
			registered.add(sessionId);
		},
		unreadCountFor(sessionId) {
			return messages.filter((message) => message.to === sessionId).length;
		},
		send(params) {
			const messageId = `m:${messages.length + 1}`;
			messages.push({ ...params, messageId });
			return {
				content: [{ type: "text", text: `accepted ${messageId}` }],
				details: {
					schemaVersion: 1,
					messageId,
					from: "main-session",
					to: params.to,
					acceptedAt: new Date().toISOString(),
					disposition: "local_mailbox",
					recipientPresence: "offline",
					wake: "unavailable",
				},
			};
		},
	};
	return { support, registered, messages };
}

function createSession(root: string) {
	return async (request: CreateChildSessionRequest) => {
		const sessionFile = join(root, "sessions", `${request.sessionId}.jsonl`);
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: request.sessionId,
					timestamp: new Date().toISOString(),
					cwd: request.cwd,
					parentSession: request.parentSessionFile,
				}),
				JSON.stringify({
					type: "custom_message",
					id: `identity-${request.sessionId}`,
					timestamp: new Date().toISOString(),
					customType: request.identityCustomType,
					content: request.identityContent,
					display: false,
					details: request.identityDetails,
				}),
			].join("\n")}\n`,
			{ mode: 0o600 },
		);
		return { sessionFile };
	};
}

function fakeWorktree(root: string) {
	const provisions: number[] = [];
	const makeRecord = (input: {
		sessionId: string;
		parentSessionId: string;
		requestedCwd: string;
		generation?: number;
	}): TeammateWorktreeRecord => {
		const generation = input.generation ?? 1;
		provisions.push(generation);
		const checkoutPath = join(root, "worktrees", input.sessionId, String(generation));
		mkdirSync(checkoutPath, { recursive: true });
		const manifestPath = join(root, "receipts", input.sessionId, String(generation), "manifest.json");
		mkdirSync(dirname(manifestPath), { recursive: true });
		return {
			version: 1,
			generation,
			sessionId: input.sessionId,
			parentSessionId: input.parentSessionId,
			repoRoot: root,
			gitCommonDir: join(root, ".git"),
			collaborationRoot: root,
			checkoutPath,
			checkoutCwd: checkoutPath,
			requestedRelativeCwd: "",
			branch: `test-${generation}`,
			baseCommit: "base",
			manifestPath,
			state: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	};
	const receipt = (record: TeammateWorktreeRecord): TeammateChangeReceipt => ({
		createdAt: Date.now(),
		baseCommit: record.baseCommit,
		headCommit: record.baseCommit,
		snapshotTree: "tree",
		patchPath: join(dirname(record.manifestPath), "changes.patch"),
		patchSha256: "sha",
		patchBytes: 0,
		changedFiles: [],
		insertions: 0,
		deletions: 0,
		includesIgnoredFiles: false,
		includesEmptyDirectories: false,
	});
	const manager = {
		async validate(record: TeammateWorktreeRecord) {
			return record;
		},
		async provision(input: Parameters<TeammateWorktreeManager["provision"]>[0]) {
			return makeRecord(input);
		},
		async captureReceipt(record: TeammateWorktreeRecord) {
			record.receipt ??= receipt(record);
			record.state = "terminal_unintegrated";
			return record.receipt;
		},
		async reactivate(record: TeammateWorktreeRecord) {
			record.state = "active";
			record.receipt = undefined;
		},
		async integrate(record: TeammateWorktreeRecord): Promise<TeammateIntegrationResult> {
			record.state = "integrated";
			return { status: "applied", changedFiles: ["x.ts"], cleanupPending: false };
		},
		async discard(record: TeammateWorktreeRecord) {
			record.state = "discarded";
		},
	};
	return { manager: manager as unknown as TeammateWorktreeManager, provisions };
}

describe("HCP multiagent Tool Source", () => {
	let root: string;
	let parentFile: string;
	let registryPath: string;
	let spawns: SpawnRecord[];
	let mailbox: ReturnType<typeof createMailbox>;
	let controller: MultiagentController;
	let source: Parameters<MultiagentBackgroundPort["registerSource"]>[0] | undefined;
	let ids: number;

	const createController = (
		options: {
			worktreeManager?: TeammateWorktreeManager;
			spawnAgent?: MultiagentSpawn;
			parentSessionFile?: string | null;
			createChildSession?: ReturnType<typeof createSession>;
			rpcTimeoutMs?: number;
		} = {},
	) => {
		const backgroundEvents: MultiagentBackgroundPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		return new MultiagentController({
			cwd: root,
			agentDir: join(root, "agent"),
			peerMessageDbPath: join(root, "messages.db"),
			registryPath,
			parentSessionId: "main-session",
			parentSessionFile: options.parentSessionFile === null ? undefined : (options.parentSessionFile ?? parentFile),
			backgroundEvents,
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			createChildSession: options.createChildSession ?? createSession(root),
			getMailboxSupport: () => mailbox.support,
			rpcTimeoutMs: options.rpcTimeoutMs,
			spawnAgent: options.spawnAgent ?? createSpawn(spawns),
			createSessionId: () => `session-${++ids}`,
			worktreeManager: options.worktreeManager,
		});
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hcp-multiagent-"));
		parentFile = join(root, "main.jsonl");
		writeFileSync(
			parentFile,
			`${JSON.stringify({ type: "session", version: 3, id: "main-session", timestamp: new Date().toISOString(), cwd: root })}\n`,
		);
		registryPath = join(root, "agent", "multiagent", "main-session.json");
		spawns = [];
		mailbox = createMailbox();
		ids = 0;
		controller = createController();
	});

	afterEach(async () => {
		await controller.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	it("publishes only Session-id lifecycle actions and no send/assignment surface", () => {
		const tool = controller.createToolDefinition();
		const schema = tool.parameters as { properties: Record<string, unknown>; additionalProperties: boolean };
		expect(Object.keys(schema.properties).sort()).toEqual(
			[
				"action",
				"confirm",
				"cwd",
				"label",
				"message",
				"model",
				"provider",
				"sessionId",
				"thinking",
				"tools",
				"workspace",
			].sort(),
		);
		expect(schema.additionalProperties).toBe(false);
		for (const arguments_ of [
			{ action: "send", sessionId: "session-1", message: "x" },
			{ action: "status", teammateId: "teammate-1" },
			{ action: "stop", assignmentId: "a" },
		]) {
			const call: ToolCall = { type: "toolCall", id: "invalid", name: "multiagent", arguments: arguments_ };
			expect(() => validateToolArguments(tool as unknown as Tool, call)).toThrow("Validation failed");
		}
	});

	it("uses a five-minute RPC response deadline without limiting persistent Session lifetime", () => {
		expect(DEFAULT_MULTIAGENT_RPC_TIMEOUT_MS).toBe(5 * 60_000);
		expect(controller.createToolDefinition().parameters).not.toHaveProperty("properties.timeoutSeconds");
	});

	it("reapplies RPC log retention before each launch in a long-lived controller", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("status", { action: "status" });
		const staleDirectory = join(root, "agent", "tmp", "multiagent", "stale-session");
		const staleLog = join(staleDirectory, "old.rpc.log");
		mkdirSync(staleDirectory, { recursive: true });
		writeFileSync(staleLog, "reproducible trace");
		utimesSync(staleLog, new Date(0), new Date(0));

		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");

		expect(existsSyncSafe(staleLog)).toBe(false);
		await waitUntil(() => existsSyncSafe(rpcLogPath(root, "session-1")));
	});

	it("reclaims old generation logs while a persistent Session is resumed repeatedly", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		const sessionLogDirectory = join(root, "agent", "tmp", "multiagent", "session-1");

		for (let generation = 1; generation <= 2; generation++) {
			await tool.execute("stop", { action: "stop", sessionId: "session-1" });
			await waitUntil(async () => (await statusState(tool, "session-1")) === "stopped");
			const staleLog = join(sessionLogDirectory, `generation-${generation}-old.rpc.log`);
			writeFileSync(staleLog, "closed generation trace");
			utimesSync(staleLog, new Date(0), new Date(0));

			await tool.execute("resume", { action: "resume", sessionId: "session-1" });
			await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
			expect(existsSyncSafe(staleLog)).toBe(false);
		}
	});

	it("allows a testable RPC deadline override for launch readiness", async () => {
		await controller.dispose();
		controller = createController({
			spawnAgent: createSpawn(spawns, { ready: false }),
			rpcTimeoutMs: 15,
		});
		const tool = controller.createToolDefinition();
		const startedAt = Date.now();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "failed");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(spawns).toHaveLength(1);
	});

	it.each([0, Number.NaN, Number.POSITIVE_INFINITY, NODE_MAX_TIMEOUT_MS + 1])(
		"rejects invalid RPC deadline override %s",
		(rpcTimeoutMs) => {
			expect(() => createController({ rpcTimeoutMs })).toThrow(/multiagent rpcTimeoutMs/);
		},
	);

	it("rejects start from an ephemeral Main that cannot provide lineage or Todo projection", async () => {
		await controller.dispose();
		controller = createController({ parentSessionFile: null });
		await expect(controller.createToolDefinition().execute("start", { action: "start" })).rejects.toMatchObject({
			details: { code: "invalid_state" },
		});
		expect(spawns).toHaveLength(0);
	});

	it("durably registers by Session id, queues process startup, and accepts bootstrap through Mailbox support", async () => {
		const tool = controller.createToolDefinition();
		const result = await tool.execute("start", { action: "start", label: "reviewer", message: "inspect parser" });
		expect(result.details).toMatchObject({
			schemaVersion: 1,
			action: "start",
			sessionId: "session-1",
			desiredProcessState: "running",
			observedProcessState: "queued",
		});
		expect(mailbox.registered).toContain("session-1");
		await waitUntil(() => spawns.length === 1 && mailbox.messages.length === 1);
		expect(mailbox.messages[0]).toMatchObject({ to: "session-1", content: "inspect parser" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		expect(spawns[0]!.args).toEqual(expect.arrayContaining(["--mode", "rpc", "--no-extensions", "--tools"]));
		const childEnvironment = spawns[0]!.options.env as Record<string, string>;
		expect(childEnvironment.MAGENTA_MAIN_TODO_SESSION_FILE).toBe(parentFile);
		expect(childEnvironment.MAGENTA_INTERNAL_RPC_SUPPRESS_MESSAGE_UPDATES).toBe("1");
		expect(source?.getEvents()[0]).toMatchObject({ status: "idle", activityPhase: "idle" });
		spawns[0]!.child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
		await waitUntil(() => source?.getEvents()[0]?.activityPhase === "active");
		expect(source?.getEvents()[0]).toMatchObject({ status: "running", activityPhase: "active" });
		spawns[0]!.child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
		await waitUntil(() => source?.getEvents()[0]?.activityPhase === "idle");
		expect(source?.getEvents()[0]?.status).toBe("idle");
		expect(existsSyncSafe(registryPath)).toBe(true);
	});

	it("suppresses streaming RPC payloads and summarizes them before retained lines", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		const child = spawns[0]!.child;
		const cumulativePayload = "must-not-reach-the-rpc-log".repeat(1_000);
		for (let index = 0; index < 3; index++) {
			child.stdout.write(
				`${JSON.stringify({
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: cumulativePayload }] },
					assistantMessageEvent: { type: "text_delta", delta: "x", partial: cumulativePayload },
				})}\n`,
			);
		}
		child.stdout.write("unparseable-rpc-line\n");
		for (let index = 0; index < 2; index++) {
			child.stdout.write(`${JSON.stringify({ type: "message_update", message: { partial: cumulativePayload } })}\n`);
		}
		child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);

		const logPath = rpcLogPath(root, "session-1");
		await waitUntil(() => {
			const log = readFileSync(logPath, "utf8");
			return log.includes('"suppressedMessageUpdates":2') && log.includes('"type":"agent_end"');
		});
		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(cumulativePayload);
		expect(log).not.toContain('"type":"message_update"');
		expect(log).toContain('"suppressedMessageUpdates":3');
		expect(log).toContain("unparseable-rpc-line");
		expect(log).toContain('"suppressedMessageUpdates":2');
		expect(log.indexOf('"suppressedMessageUpdates":3')).toBeLessThan(log.indexOf("unparseable-rpc-line"));
		expect(log.indexOf('"suppressedMessageUpdates":2')).toBeLessThan(log.indexOf('"type":"agent_end"'));
	});

	it("flushes the streaming RPC suppression count when the child exits", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		spawns[0]!.child.stdout.write(`${JSON.stringify({ type: "message_update", message: { partial: "private" } })}\n`);
		spawns[0]!.child.emit("close", 1, null);
		await waitUntil(async () => (await statusState(tool, "session-1")) === "failed");
		const logPath = rpcLogPath(root, "session-1");
		await waitUntil(() => readFileSync(logPath, "utf8").includes('"suppressedMessageUpdates":1'));
		expect(readFileSync(logPath, "utf8")).not.toContain('"partial":"private"');
	});

	it("flushes buffered stderr and RPC tail output when the child exits", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		const child = spawns[0]!.child;
		child.stderr.write("terminal stderr tail\n");
		child.stdout.write("terminal rpc tail\n");
		child.emit("close", 1, null);

		await waitUntil(async () => (await statusState(tool, "session-1")) === "failed");
		const log = readFileSync(rpcLogPath(root, "session-1"), "utf8");
		expect(log).toContain("terminal stderr tail");
		expect(log).toContain("terminal rpc tail");
	});

	it("does not overwrite terminal state when the process exits during readiness settlement", async () => {
		controller = createController({ spawnAgent: createSpawn(spawns, { closeAfterReady: true }) });
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "failed");
		const status = await tool.execute("status", { action: "status", sessionId: "session-1" });
		expect((status.details as any).capacity.running).toBe(0);
		expect((status.details as any).teammates[0]).toMatchObject({
			desiredProcessState: "running",
			observedProcessState: "failed",
		});
	});

	it("runs at most sixteen processes and starts the seventeenth FIFO", async () => {
		const tool = controller.createToolDefinition();
		for (let index = 0; index < 17; index++)
			await tool.execute(`start-${index}`, { action: "start", label: `t${index}` });
		await waitUntil(() => spawns.length === 16);
		expect(await statusState(tool, "session-17")).toBe("queued");
		spawns[0]!.child.emit("close", 1, null);
		await waitUntil(() => spawns.length === 17);
		expect(spawns[16]!.sessionId).toBe("session-17");
	});

	it("accepts hard interrupt intent and delivers an optional replacement only after abort", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		const result = await tool.execute("interrupt", {
			action: "interrupt",
			sessionId: "session-1",
			message: "replace the current turn",
		});
		expect(result.details).toMatchObject({ action: "interrupt", desiredProcessState: "running" });
		expect(["interrupting", "idle"]).toContain((result.details as any).observedProcessState);
		await waitUntil(() => mailbox.messages.some((message) => message.content === "replace the current turn"));
		expect(await statusState(tool, "session-1")).toBe("idle");
	});

	it("does not deliver an interrupt replacement after stop revokes the pending interrupt", async () => {
		const abortResponses: Array<() => void> = [];
		let resolveAbortRequest!: () => void;
		const abortRequested = new Promise<void>((resolve) => {
			resolveAbortRequest = resolve;
		});
		controller = createController({
			spawnAgent: createSpawn(spawns, {
				deferredAbortResponses: abortResponses,
				onDeferredAbortRequest: resolveAbortRequest,
			}),
		});
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		await tool.execute("interrupt", {
			action: "interrupt",
			sessionId: "session-1",
			message: "must not be delivered",
		});
		await abortRequested;
		expect(abortResponses).toHaveLength(1);
		await tool.execute("stop", { action: "stop", sessionId: "session-1" });
		spawns[0]!.child.emit("close", 0, null);
		abortResponses.shift()?.();
		await waitUntil(async () => (await statusState(tool, "session-1")) === "stopped");
		expect(mailbox.messages.some((message) => message.content === "must not be delivered")).toBe(false);
		const status = await tool.execute("status", { action: "status", sessionId: "session-1" });
		expect((status.details as any).teammates[0].lastError).toBeUndefined();
	});

	it("keeps desired-running across controller disposal and auto-resumes once on exact Main reopen", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		await controller.dispose();
		const firstSpawnCount = spawns.length;
		controller = createController();
		const reopened = controller.createToolDefinition();
		await waitUntil(() => spawns.length === firstSpawnCount + 1);
		await waitUntil(async () => (await statusState(reopened, "session-1")) === "idle");
		const status = await reopened.execute("status", { action: "status", sessionId: "session-1" });
		const teammate = (status.details as { teammates: MultiagentRecord[] }).teammates[0] as unknown as {
			desiredProcessState: string;
			processGeneration: number;
		};
		expect(teammate.desiredProcessState).toBe("running");
		expect(teammate.processGeneration).toBe(2);
	});

	it("settles concurrent idempotent disposal while RPC readiness is still pending", async () => {
		controller = createController({ spawnAgent: createSpawn(spawns, { ready: false }) });
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(() => spawns.length === 1);
		await Promise.all([controller.dispose(), controller.dispose(), controller.dispose()]);
		const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { records: MultiagentRecord[] };
		expect(registry.records[0]).toMatchObject({
			desiredProcessState: "running",
			observedProcessState: "stopped",
		});
		expect(registry.records[0]).not.toHaveProperty("processPid");
	});

	it("waits for an in-flight start before final disposal persistence", async () => {
		await controller.dispose();
		let releaseChild!: () => void;
		let enteredChild!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredChild = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const createChild = createSession(root);
		controller = createController({
			createChildSession: async (request) => {
				enteredChild();
				await released;
				return createChild(request);
			},
		});
		const start = controller.createToolDefinition().execute("start", { action: "start" });
		await entered;
		const disposing = controller.dispose();
		releaseChild();
		await Promise.all([start, disposing]);
		const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { records: MultiagentRecord[] };
		expect(registry.records[0]).toMatchObject({
			desiredProcessState: "running",
			observedProcessState: "stopped",
		});
		expect(spawns).toHaveLength(0);
	});

	it("refuses automatic resume when the managed Session identity no longer matches Main", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		await controller.dispose();
		const firstSpawnCount = spawns.length;
		const sessionFile = join(root, "sessions", "session-1.jsonl");
		const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const identity = JSON.parse(lines[1]!) as { details: { parentSessionId: string } };
		identity.details.parentSessionId = "other-main";
		lines[1] = JSON.stringify(identity);
		writeFileSync(sessionFile, `${lines.join("\n")}\n`);

		controller = createController();
		const reopened = controller.createToolDefinition();
		const status = await reopened.execute("status", { action: "status", sessionId: "session-1" });
		expect((status.details as any).teammates[0]).toMatchObject({
			desiredProcessState: "running",
			observedProcessState: "failed",
			lastError: expect.stringContaining("identity"),
		});
		expect(spawns).toHaveLength(firstSpawnCount);
	});

	it("does not auto-resume an explicitly stopped Session", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		await tool.execute("stop", { action: "stop", sessionId: "session-1" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "stopped");
		await controller.dispose();
		const count = spawns.length;
		controller = createController();
		await controller.createToolDefinition().execute("status", { action: "status" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(spawns).toHaveLength(count);
	});

	it("rejects control of a Session outside the exact durable lineage", async () => {
		const tool = controller.createToolDefinition();
		await expect(tool.execute("stop", { action: "stop", sessionId: "foreign-session" })).rejects.toMatchObject({
			details: { schemaVersion: 1, code: "not_found", target: "foreign-session" },
		});
	});

	it("creates a new worktree generation after integration while retaining the same Session id", async () => {
		await controller.dispose();
		const worktrees = fakeWorktree(root);
		controller = createController({ worktreeManager: worktrees.manager });
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start", workspace: "worktree" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		await tool.execute("stop", { action: "stop", sessionId: "session-1" });
		await waitUntil(async () => (await statusState(tool, "session-1")) === "stopped");
		await tool.execute("integrate", { action: "integrate", sessionId: "session-1" });
		const resumed = await tool.execute("resume", { action: "resume", sessionId: "session-1" });
		expect(resumed.details).toMatchObject({ sessionId: "session-1", observedProcessState: "queued" });
		expect(worktrees.provisions).toEqual([1, 2]);
		await waitUntil(async () => (await statusState(tool, "session-1")) === "idle");
		const status = await tool.execute("status", { action: "status", sessionId: "session-1" });
		expect((status.details as any).teammates[0].workspace).toMatchObject({ generation: 2, state: "active" });
	});
});

async function statusState(tool: ReturnType<MultiagentController["createToolDefinition"]>, sessionId: string) {
	const result = await tool.execute("status", { action: "status", sessionId });
	return (result.details as { teammates: Array<{ observedProcessState: string }> }).teammates[0]?.observedProcessState;
}

function existsSyncSafe(path: string): boolean {
	try {
		return readFileSync(path).byteLength > 0;
	} catch {
		return false;
	}
}

function rpcLogPath(root: string, sessionId: string): string {
	const directory = join(root, "agent", "tmp", "multiagent", sessionId);
	const file = readdirSync(directory).find((entry) => entry.endsWith(".rpc.log"));
	if (!file) throw new Error(`Missing RPC log for ${sessionId}`);
	return join(directory, file);
}
