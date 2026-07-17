import { type ChildProcess, execFileSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEventManager, type EventSource } from "../src/core/background-events.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { PeerSendInput } from "../src/core/tools/send-message.ts";
import { TeammateAgentController, type TeammateAgentSpawn } from "../src/core/tools/teammate-agent.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		signal: undefined,
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: {} as ExtensionContext["ui"]["theme"],
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		},
	};
}

type SpawnRecord = {
	command: string;
	args: string[];
	options: SpawnOptions;
	commands: string[];
	child: ChildProcess;
};

type SessionStatsResponseMode = "success" | "failure" | "timeout";

type TeammateAgentTool = ReturnType<TeammateAgentController["createToolDefinition"]>;
type InternalWaitTeammateAgentInputForTest = {
	action: "wait";
	teammateId: string;
	assignmentId?: string;
	waitTimeoutSeconds?: number;
};
type InternalWaitTeammateAgentExecutorForTest = (
	toolCallId: string,
	params: InternalWaitTeammateAgentInputForTest,
	signal: Parameters<TeammateAgentTool["execute"]>[2],
	onUpdate: Parameters<TeammateAgentTool["execute"]>[3],
	ctx: Parameters<TeammateAgentTool["execute"]>[4],
) => ReturnType<TeammateAgentTool["execute"]>;

// The runtime keeps wait for internal callers, while the model-visible schema intentionally excludes it.
function internalWaitExecutorForTest(tool: TeammateAgentTool): InternalWaitTeammateAgentExecutorForTest {
	return tool.execute as unknown as InternalWaitTeammateAgentExecutorForTest;
}

function createRpcSpawn(
	records: SpawnRecord[],
	sequence: string[],
	getSessionStatsResponseMode: () => SessionStatsResponseMode,
): TeammateAgentSpawn {
	return (command, args, options) => {
		const child = new EventEmitter() as ChildProcess;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const commands: string[] = [];
		let input = "";
		let closed = false;
		const close = (code = 0, signal: NodeJS.Signals | null = null) => {
			if (closed) return;
			closed = true;
			stdout.end();
			stderr.end();
			child.emit("close", code, signal);
		};
		const stdin = new Writable({
			write(chunk, _encoding, callback) {
				input += chunk.toString();
				while (input.includes("\n")) {
					const newline = input.indexOf("\n");
					const line = input.slice(0, newline);
					input = input.slice(newline + 1);
					if (!line) continue;
					const request = JSON.parse(line) as { id: string; type: string };
					commands.push(request.type);
					sequence.push(`rpc:${request.type}`);
					let response: Record<string, unknown>;
					if (request.type === "get_state") {
						response = {
							id: request.id,
							type: "response",
							command: "get_state",
							success: true,
							data: {
								sessionId: "teammate-session-id",
								thinkingLevel: "low",
								isStreaming: false,
								isCompacting: false,
								steeringMode: "one-at-a-time",
								followUpMode: "one-at-a-time",
								autoCompactionEnabled: true,
								messageCount: 1,
								pendingMessageCount: 0,
							},
						};
					} else if (request.type === "get_session_stats") {
						const mode = getSessionStatsResponseMode();
						if (mode === "timeout") continue;
						response =
							mode === "failure"
								? {
										id: request.id,
										type: "response",
										command: request.type,
										success: false,
										error: "stats unavailable",
									}
								: {
										id: request.id,
										type: "response",
										command: request.type,
										success: true,
										data: {
											sessionFile: "/tmp/teammate.jsonl",
											sessionId: "teammate-session-id",
											userMessages: 12,
											assistantMessages: 151,
											toolCalls: 45,
											toolResults: 45,
											totalMessages: 208,
											tokens: {
												input: 462_000,
												output: 67_000,
												cacheRead: 30_000_000,
												cacheWrite: 51_000,
												total: 30_580_000,
											},
											cost: 19.504,
											contextUsage: { tokens: 351_540, contextWindow: 372_000, percent: 94.5 },
										},
									};
					} else {
						response = { id: request.id, type: "response", command: request.type, success: true };
					}
					queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`));
				}
				callback();
			},
			final(callback) {
				queueMicrotask(() => close());
				callback();
			},
		});
		Object.assign(child, {
			stdin,
			stdout,
			stderr,
			pid: 999999,
			exitCode: null,
			signalCode: null,
			kill: () => {
				close(null as never, "SIGTERM");
				return true;
			},
		});
		records.push({ command, args, options, commands, child });
		return child;
	};
}

describe("built-in teammate_agent tool", () => {
	let tempDir: string;
	let manager: BackgroundEventManager;
	let controller: TeammateAgentController;
	let parentSession: SessionManager;
	let parentSessionFile: string;
	let peerMessages: PeerSendInput[];
	let spawnRecords: SpawnRecord[];
	let sequence: string[];
	let unreadPeerMessages: number;
	let teammateSource: EventSource;
	let sessionStatsResponseMode: SessionStatsResponseMode;
	let peerSendError: Error | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-teammate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		parentSession = SessionManager.create(tempDir, tempDir, { id: "parent-session-id" });
		parentSession.appendSessionInfo("parent");
		parentSession.flush();
		parentSessionFile = parentSession.getSessionFile()!;
		manager = new BackgroundEventManager();
		const registerSource = manager.registerSource.bind(manager);
		vi.spyOn(manager, "registerSource").mockImplementation((source) => {
			if (source.id === "teammates") teammateSource = source;
			return registerSource(source);
		});
		peerMessages = [];
		spawnRecords = [];
		sequence = [];
		unreadPeerMessages = 0;
		sessionStatsResponseMode = "success";
		peerSendError = undefined;
		controller = new TeammateAgentController(manager, {
			sendPeerMessage: (params) => {
				if (peerSendError) throw peerSendError;
				peerMessages.push(params);
				sequence.push("peer:send");
				return {
					content: [{ type: "text", text: `sent to ${params.to}` }],
					details: {
						id: `message-${peerMessages.length}`,
						to: params.to,
						from: "parent-session-id",
						urgent: params.urgent === true,
						recipientStatus: "idle",
						woken: params.urgent === true,
					},
				};
			},
			getUnreadPeerMessageCount: () => unreadPeerMessages,
			getParentSessionId: () => "parent-session-id",
			getParentSessionFile: () => parentSessionFile,
			getParentSessionDir: () => tempDir,
			getAgentDirPath: () => tempDir,
			getPeerMessageDbPath: () => join(tempDir, "messages.db"),
			getDefaultModel: () => ({ provider: "openai", model: "gpt-5.6-sol" }),
			spawnAgent: createRpcSpawn(spawnRecords, sequence, () => sessionStatsResponseMode),
			agentCommand: "magenta-test",
			createSessionId: () => "teammate-session-id",
		});
	});

	afterEach(async () => {
		await controller.shutdown();
		manager.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function startTeammate(tools?: string[]) {
		return controller
			.createToolDefinition()
			.execute(
				"call-start",
				{ action: "start", label: "reviewer", thinking: "low", tools },
				undefined,
				undefined,
				createContext(tempDir),
			);
	}

	async function waitForTeammateTerminal(teammateId: string): Promise<void> {
		await vi.waitFor(() => {
			expect(manager.getEvents().find((event) => event.id === teammateId)?.status).not.toBe("running");
		});
	}

	function emitRpcEvent(payload: Record<string, unknown>, record = spawnRecords.at(-1)): void {
		(record?.child.stdout as PassThrough | undefined)?.write(`${JSON.stringify(payload)}\n`);
	}

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		}).trim();
	}

	function createControllerWithInvocation(
		spawnAgent: TeammateAgentSpawn,
		resolveAgentInvocation: (args: string[]) => { command: string; args: string[] },
	): TeammateAgentController {
		return new TeammateAgentController(manager, {
			sendPeerMessage: (params) => {
				peerMessages.push(params);
				sequence.push("peer:send");
				return {
					content: [{ type: "text", text: `sent to ${params.to}` }],
					details: {
						id: `message-${peerMessages.length}`,
						to: params.to,
						from: "parent-session-id",
						urgent: params.urgent === true,
						recipientStatus: "idle" as const,
						woken: params.urgent === true,
					},
				};
			},
			getUnreadPeerMessageCount: () => unreadPeerMessages,
			getParentSessionId: () => "parent-session-id",
			getParentSessionFile: () => parentSessionFile,
			getParentSessionDir: () => tempDir,
			getAgentDirPath: () => tempDir,
			getPeerMessageDbPath: () => join(tempDir, "messages.db"),
			spawnAgent,
			resolveAgentInvocation,
			createSessionId: () => "teammate-session-id",
		});
	}

	it("describes a parent-runtime child control plane and the one-shot boundary", () => {
		const tool = controller.createToolDefinition();
		expect(tool.description).toContain("parent-managed, long-lived");
		expect(tool.description).toContain("current parent runtime");
		expect(tool.description).toContain("lifecycle/control plane");
		expect(JSON.stringify(tool.parameters)).not.toContain("humanHandoff");
		expect(JSON.stringify(tool.parameters)).not.toContain("Side/BTW");
		const properties = (tool.parameters as any).properties;
		expect(JSON.stringify(properties.action)).not.toContain('"wait"');
		expect(properties.assignmentId).toBeUndefined();
		expect(properties.waitTimeoutSeconds).toBeUndefined();
		expect((tool.parameters as any).additionalProperties).toBe(false);
		expect(tool.promptGuidelines?.join("\n")).toContain("external activation");
		expect(tool.promptGuidelines?.join("\n")).toContain("do not poll status");
		expect(tool.promptGuidelines?.join("\n")).not.toContain("action=wait");
		expect(tool.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("retained context"),
				expect.stringContaining("bounded one-shot delegation"),
				expect.stringContaining("soft lease"),
				expect.stringContaining("non-overlapping owned files or globs"),
				expect.stringContaining("not a security sandbox or runtime lock"),
				expect.stringContaining("becoming idle does not release"),
				expect.stringContaining("terminal receipts"),
				expect.stringContaining("stops children automatically"),
			]),
		);

		const aiTool = tool as unknown as Tool;
		for (const arguments_ of [
			{ action: "wait", teammateId: "teammate_001" },
			{ action: "status", assignmentId: "teammate_001:assignment_1" },
			{ action: "status", waitTimeoutSeconds: 30 },
		]) {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: "call-invalid-teammate-agent",
				name: tool.name,
				arguments: arguments_,
			};
			expect(() => validateToolArguments(aiTool, toolCall)).toThrow("Validation failed");
		}
	});

	it("rejects an unconfirmed human Side/BTW handoff before creating any process or mailbox message", async () => {
		await expect(
			controller.startHumanSideHandoff(
				{
					confirmed: false,
					origin: "side",
					conversationId: "side-1",
					label: "side handoff",
					context: "Human: investigate this",
					messageCount: 1,
					originalBytes: 23,
					truncated: false,
				} as never,
				createContext(tempDir),
			),
		).rejects.toThrow("explicit human confirmation");
		expect(spawnRecords).toHaveLength(0);
		expect(peerMessages).toHaveLength(0);
	});

	it("starts a human-approved invitation without creating an assignment lease", async () => {
		const handoff = await controller.startHumanSideHandoff(
			{
				confirmed: true,
				origin: "btw",
				conversationId: "btw-conversation-1",
				label: "btw · investigate the queue",
				context: "Human: Could this become a teammate?\n\nSide assistant: Ask the main agent for a scoped task.",
				messageCount: 2,
				originalBytes: 91,
				truncated: false,
			},
			createContext(tempDir),
		);

		expect(sequence).toEqual(["rpc:get_state", "peer:send"]);
		expect(handoff).toMatchObject({
			teammateId: "teammate_001",
			sessionId: "teammate-session-id",
			bootstrapMessageId: "message-1",
			contextTruncated: false,
		});
		expect(peerMessages).toHaveLength(1);
		expect(peerMessages[0]).toMatchObject({ to: "teammate-session-id", urgent: true });
		expect(peerMessages[0]?.assignmentId).toBeUndefined();
		expect(peerMessages[0]?.terminalStatus).toBeUndefined();
		expect(peerMessages[0]?.content).toContain("human-approved Side/BTW teammate invitation");
		expect(peerMessages[0]?.content).toContain("creates no ownership lease");
		expect(peerMessages[0]?.content).toContain("managedTeammateId: teammate_001");
		expect(peerMessages[0]?.content).toContain("Omit assignmentId and terminalStatus");

		const sessionFile = spawnRecords[0]?.args[spawnRecords[0].args.indexOf("--session") + 1];
		const childSession = SessionManager.open(sessionFile!);
		const hiddenHandoff = childSession
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "magenta-human-side-handoff.v1");
		expect(hiddenHandoff).toMatchObject({
			type: "custom_message",
			display: false,
			details: {
				version: 1,
				humanRequested: true,
				origin: "btw",
				conversationId: "btw-conversation-1",
			},
		});
		expect(hiddenHandoff && hiddenHandoff.type === "custom_message" ? hiddenHandoff.content : "").toContain(
			"Could this become a teammate?",
		);
		expect(hiddenHandoff && hiddenHandoff.type === "custom_message" ? hiddenHandoff.details : {}).not.toHaveProperty(
			"context",
		);
		const status = await controller
			.createToolDefinition()
			.execute(
				"call-status-human-handoff",
				{ action: "status", teammateId: "teammate_001" },
				undefined,
				undefined,
				createContext(tempDir),
			);
		expect(textOf(status)).toContain("Assignment: none");
		expect(textOf(status)).toContain(`Human handoff: ${handoff.handoffId}`);
		expect(JSON.stringify(status.details)).not.toContain("Could this become a teammate?");
		expect(status.details?.humanHandoff).not.toHaveProperty("context");
	});

	it("bounds multibyte handoff context without splitting UTF-8", async () => {
		const handoff = await controller.startHumanSideHandoff(
			{
				confirmed: true,
				origin: "side",
				conversationId: "large-side",
				label: "large side handoff",
				context: "界".repeat(10_000),
				messageCount: 1,
				originalBytes: 30_000,
				truncated: false,
			},
			createContext(tempDir),
		);
		expect(handoff.contextBytes).toBeLessThanOrEqual(16 * 1024);
		expect(handoff.contextTruncated).toBe(true);
		const sessionFile = spawnRecords[0]?.args[spawnRecords[0].args.indexOf("--session") + 1];
		const hidden = SessionManager.open(sessionFile!)
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "magenta-human-side-handoff.v1");
		const content = hidden && hidden.type === "custom_message" ? String(hidden.content) : "";
		expect(content).toContain("contextTruncated: true");
		expect(content).not.toContain("�");
	});

	it("stops and marks the child failed when the post-readiness invitation cannot be persisted", async () => {
		peerSendError = new Error("mailbox unavailable");
		await expect(
			controller.startHumanSideHandoff(
				{
					confirmed: true,
					origin: "side",
					conversationId: "failed-side",
					label: "failed side handoff",
					context: "Human: ask the main agent first",
					messageCount: 1,
					originalBytes: 31,
					truncated: false,
				},
				createContext(tempDir),
			),
		).rejects.toThrow("mailbox unavailable");
		expect(sequence).toEqual(["rpc:get_state", "rpc:abort"]);
		expect(peerMessages).toHaveLength(0);
		const status = await controller
			.createToolDefinition()
			.execute(
				"call-status-failed-handoff",
				{ action: "status", teammateId: "teammate_001" },
				undefined,
				undefined,
				createContext(tempDir),
			);
		expect(status.details).toMatchObject({ status: "failed" });
		expect(textOf(status)).toContain("Failed to deliver human Side/BTW invitation");
	});

	it("cleans the unregistered session and log when spawn throws synchronously", async () => {
		await controller.shutdown();
		let attemptedSessionFile: string | undefined;
		controller = createControllerWithInvocation(
			(_command, args) => {
				attemptedSessionFile = args[args.indexOf("--session") + 1];
				throw new Error("spawn failed synchronously");
			},
			(args) => ({ command: "/opt/node/bin/node", args: ["/repo/dist/cli.js", ...args] }),
		);

		await expect(startTeammate()).rejects.toThrow("spawn failed synchronously");

		expect(attemptedSessionFile).toBeDefined();
		expect(existsSync(attemptedSessionFile!)).toBe(false);
		expect(readdirSync(join(tempDir, "tmp", "teammates"))).toEqual([]);
		expect(manager.getEvents().find((event) => event.id === "teammate_001")).toBeUndefined();
	});

	it("creates a clean persisted child session with identity and parent lineage", async () => {
		const started = await startTeammate(["read", "sub_agent", "teammate_agent"]);
		const sessionFile = started.details?.sessionFile as string;
		const childSession = SessionManager.open(sessionFile);

		expect(started.details).toMatchObject({
			id: "teammate_001",
			status: "running",
			activity: "idle",
			sessionId: "teammate-session-id",
			parentSessionId: "parent-session-id",
		});
		expect(childSession.getHeader()).toMatchObject({
			id: "teammate-session-id",
			parentSession: parentSessionFile,
		});
		expect(childSession.getHeader()?.cwd).toBe(realpathSync(tempDir));
		expect(childSession.getSessionName()).toBe("reviewer");
		expect(childSession.getEntries().filter((entry) => entry.type === "message")).toHaveLength(0);
		const context = childSession
			.buildSessionContext()
			.messages.map((message) => JSON.stringify(message))
			.join("\n");
		expect(context).toContain("selfSessionId: teammate-session-id");
		expect(context).toContain("parentSessionId: parent-session-id");
		expect(context).toContain("structured terminal receipt");
		expect(context).toContain("public peer messages are urgent");
		expect(context).toContain("Each formal assignment is a soft lease on its stated scope");
		expect(context).toContain("invitation may arrive without assignmentId");
		expect(context).toContain("explicitly name owned non-overlapping files or globs");
		expect(context).toContain("not a runtime file lock or bash interception");
		expect(context).toContain("supplied assignmentId and terminalStatus");
		expect(context).not.toContain("urgent=true");
		expect(textOf(started)).toContain("No assignment lease is active yet");
		expect(textOf(started)).toContain("Successful delivery activates a soft lease");
		expect(textOf(started)).toContain("idle does not release it");
		expect(textOf(started)).toContain("Editing assignments must name non-overlapping owned files or globs");

		expect(spawnRecords).toHaveLength(1);
		expect(spawnRecords[0]?.command).toBe("magenta-test");
		expect(spawnRecords[0]?.args).toEqual(
			expect.arrayContaining([
				"--mode",
				"rpc",
				"--session",
				sessionFile,
				"--no-extensions",
				"--tools",
				"read,send_message",
				"--provider",
				"openai",
				"--model",
				"gpt-5.6-sol",
			]),
		);
		expect((spawnRecords[0]?.options.env as NodeJS.ProcessEnv).PI_TEAMMATE_AGENT).toBe("1");
		expect((spawnRecords[0]?.options.env as NodeJS.ProcessEnv).MAGENTA_CODING_AGENT_DIR).toBe(tempDir);
		expect((spawnRecords[0]?.options.env as NodeJS.ProcessEnv).MAGENTA_PEER_MESSAGE_DB).toBe(
			join(tempDir, "messages.db"),
		);
		expect((spawnRecords[0]?.options.env as NodeJS.ProcessEnv).MAGENTA_TEAMMATE_PARENT_SESSION_ID).toBe(
			"parent-session-id",
		);
		expect(manager.getEvents().find((event) => event.id === "teammate_001")).toMatchObject({
			activityPhase: "idle",
			reminderEligible: false,
			lastActivityAt: expect.any(Number),
		});
	});

	it('inherits the parent model when model is "default"', async () => {
		await controller
			.createToolDefinition()
			.execute(
				"call-start-default-model",
				{ action: "start", label: "default-model", model: "default", thinking: "low" },
				undefined,
				undefined,
				createContext(tempDir),
			);

		expect(spawnRecords[0]?.args).toEqual(expect.arrayContaining(["--provider", "openai", "--model", "gpt-5.6-sol"]));
		expect(spawnRecords[0]?.args).not.toContain("default");
	});

	it("records RPC phase and assistant output as real activity", async () => {
		await startTeammate();
		const stdout = spawnRecords[0]?.child.stdout as PassThrough;
		stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
		stdout.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "review complete" }] },
			})}\n`,
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(manager.getEvents().find((event) => event.id === "teammate_001")).toMatchObject({
			activityPhase: "active",
			reminderEligible: true,
			lastActivityAt: expect.any(Number),
			lastOutputAt: expect.any(Number),
			tail: "review complete",
		});
	});

	it("refreshes UI-only stats lazily without polluting activity, snapshots, or tool details", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		const before = manager.getEvents().find((event) => event.id === teammateId)!;
		const onUpdate = vi.fn();

		expect(teammateSource.getUiTelemetry?.(teammateId, onUpdate)).toBeUndefined();
		expect(teammateSource.getUiTelemetry?.(teammateId, onUpdate)).toBeUndefined();
		await new Promise((resolve) => setImmediate(resolve));

		expect(teammateSource.getUiTelemetry?.(teammateId, onUpdate)).toEqual({
			input: 462_000,
			output: 67_000,
			cacheRead: 30_000_000,
			cacheWrite: 51_000,
			cost: 19.504,
			contextUsage: { tokens: 351_540, percent: 94.5, contextWindow: 372_000 },
			autoCompactEnabled: true,
			assistantMessages: 151,
		});
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(spawnRecords[0]?.commands.filter((command) => command === "get_session_stats")).toHaveLength(1);
		expect(manager.getEvents().find((event) => event.id === teammateId)?.lastActivityAt).toBe(before.lastActivityAt);

		const snapshot = manager.getEvents().find((event) => event.id === teammateId)!;
		expect(snapshot).not.toHaveProperty("uiTelemetry");
		expect(JSON.stringify(snapshot)).not.toMatch(/tokens|cost|assistantMessages/);
		const status = await controller
			.createToolDefinition()
			.execute(
				"call-status-telemetry",
				{ action: "status", teammateId },
				undefined,
				undefined,
				createContext(tempDir),
			);
		expect(status.details).not.toHaveProperty("uiTelemetry");
		expect(JSON.stringify(status.details)).not.toMatch(/tokens|cost|assistantMessages/);
		expect(teammateSource.getEventDetails?.(teammateId).join("\n")).not.toMatch(/tokens|cost|assistantMessages/);

		await controller
			.createToolDefinition()
			.execute("call-stop-telemetry", { action: "stop", teammateId }, undefined, undefined, createContext(tempDir));
		expect(teammateSource.getUiTelemetry?.(teammateId, onUpdate)?.assistantMessages).toBe(151);
		expect(spawnRecords[0]?.commands.filter((command) => command === "get_session_stats")).toHaveLength(1);
		await waitForTeammateTerminal(teammateId);

		await controller
			.createToolDefinition()
			.execute(
				"call-resume-telemetry",
				{ action: "resume", teammateId },
				undefined,
				undefined,
				createContext(tempDir),
			);
		expect(teammateSource.getUiTelemetry?.(teammateId, onUpdate)).toBeUndefined();
		await new Promise((resolve) => setImmediate(resolve));
		expect(teammateSource.getUiTelemetry?.(teammateId, onUpdate)?.assistantMessages).toBe(151);
		expect(
			spawnRecords.flatMap((record) => record.commands).filter((command) => command === "get_session_stats"),
		).toHaveLength(2);
	});

	it("silently tolerates failed and timed-out UI telemetry requests", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		const before = manager.getEvents().find((event) => event.id === teammateId)?.lastActivityAt;
		const onUpdate = vi.fn();

		sessionStatsResponseMode = "failure";
		expect(() => teammateSource.getUiTelemetry?.(teammateId, onUpdate)).not.toThrow();
		await new Promise((resolve) => setImmediate(resolve));
		expect(onUpdate).not.toHaveBeenCalled();
		expect(manager.getEvents().find((event) => event.id === teammateId)?.lastActivityAt).toBe(before);

		vi.useFakeTimers();
		try {
			await vi.advanceTimersByTimeAsync(2_001);
			sessionStatsResponseMode = "timeout";
			expect(() => teammateSource.getUiTelemetry?.(teammateId, onUpdate)).not.toThrow();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(onUpdate).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers an optional first assignment through the mailbox after startup readiness", async () => {
		const started = await controller
			.createToolDefinition()
			.execute(
				"call-start-with-work",
				{ action: "start", label: "reviewer", thinking: "low", message: "Review the parser" },
				undefined,
				undefined,
				createContext(tempDir),
			);

		expect(sequence).toEqual(["rpc:get_state", "peer:send"]);
		expect(peerMessages).toHaveLength(1);
		expect(peerMessages[0]).toMatchObject({ to: "teammate-session-id", urgent: true });
		expect(peerMessages[0]?.content).toContain("Review the parser");
		expect(peerMessages[0]?.content).toContain("creates a soft lease on its stated scope");
		expect(peerMessages[0]?.content).toContain("explicitly names owned non-overlapping files or globs");
		expect(peerMessages[0]?.content).toContain("not a runtime lock or bash interception");
		expect(peerMessages[0]?.content).toContain("Report exactly one terminal result");
		expect(peerMessages[0]?.content).toContain("assignmentId: teammate_001:assignment_1");
		expect(textOf(started)).toContain("first assignment was delivered through send_message");
		expect(textOf(started)).toContain(
			"Soft assignment lease active until a result or confirmed terminal stop/cancel",
		);
		expect(textOf(started)).toContain("Idle does not release it");
	});

	it("sends repeated assignments only through the peer mailbox", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		sequence.length = 0;

		const first = await controller
			.createToolDefinition()
			.execute(
				"call-send-1",
				{ action: "send", teammateId, message: "Inspect the parser" },
				undefined,
				undefined,
				createContext(tempDir),
			);
		await controller
			.createToolDefinition()
			.execute(
				"call-send-2",
				{ action: "send", teammateId, message: "Now inspect tests", urgent: false },
				undefined,
				undefined,
				createContext(tempDir),
			);

		expect(textOf(first)).toContain("Managed teammate: teammate_001");
		expect(textOf(first)).toContain("Soft assignment lease active until a result or confirmed terminal stop/cancel");
		expect(textOf(first)).toContain("synthesize and independently verify the result");
		expect(textOf(first)).toContain("do not duplicate its scope");
		expect(textOf(first)).toContain("Idle does not release it");
		expect(peerMessages).toHaveLength(2);
		expect(peerMessages[0]).toMatchObject({ to: "teammate-session-id", urgent: true });
		expect(peerMessages[0]?.content).toContain("Inspect the parser");
		expect(peerMessages[0]?.content).toContain("replyTargetSessionId: parent-session-id");
		expect(peerMessages[0]?.content).toContain("send_message({");
		expect(peerMessages[0]?.content).not.toContain("urgent=true");
		expect(peerMessages[1]).toMatchObject({ to: "teammate-session-id", urgent: false });
		expect(spawnRecords).toHaveLength(1);
		expect(spawnRecords[0]?.commands).toEqual(["get_state"]);
		expect(sequence).toEqual(["peer:send", "peer:send"]);
	});

	it("waits for a structured terminal assignment receipt instead of treating idle as completion", async () => {
		const tool = controller.createToolDefinition();
		const executeInternalWait = internalWaitExecutorForTest(tool);
		const started = await tool.execute(
			"call-start-assignment",
			{ action: "start", label: "editor", message: "Edit owned file src/a.ts" },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const teammateId = started.details?.id as string;
		const assignmentId = started.details?.assignmentId as string;
		const timedOut = await executeInternalWait(
			"call-wait-now",
			{ action: "wait", teammateId, assignmentId, waitTimeoutSeconds: 0 },
			undefined,
			undefined,
			createContext(tempDir),
		);
		expect(timedOut.details).toMatchObject({ assignmentStatus: "active", timedOut: true });

		emitRpcEvent({
			type: "tool_execution_end",
			toolName: "send_message",
			result: {
				details: {
					id: "terminal-message",
					assignmentId,
					terminalStatus: "completed",
				},
			},
		});
		await vi.waitFor(async () => {
			const result = await executeInternalWait(
				"call-wait-terminal",
				{ action: "wait", teammateId, assignmentId, waitTimeoutSeconds: 0 },
				undefined,
				undefined,
				createContext(tempDir),
			);
			expect(result.details).toMatchObject({
				assignmentStatus: "completed",
				terminalMessageId: "terminal-message",
				timedOut: false,
			});
		});
	});

	it("aborts the active RPC turn before urgently sending a replacement instruction", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		sequence.length = 0;

		const interrupted = await controller
			.createToolDefinition()
			.execute(
				"call-interrupt",
				{ action: "interrupt", teammateId, message: "Stop and review security instead" },
				undefined,
				undefined,
				createContext(tempDir),
			);

		expect(sequence).toEqual(["rpc:abort", "peer:send"]);
		expect(peerMessages[0]).toMatchObject({ to: "teammate-session-id", urgent: true });
		expect(peerMessages[0]?.content).toContain("replacement instruction");
		expect(interrupted.details).toMatchObject({ abortedFirst: true, teammateId, sessionId: "teammate-session-id" });
	});

	it("resumes a stopped teammate with the same persistent session", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		const sessionFile = started.details?.sessionFile as string;
		await controller
			.createToolDefinition()
			.execute(
				"call-stop-before-resume",
				{ action: "stop", teammateId },
				undefined,
				undefined,
				createContext(tempDir),
			);
		const oldChild = spawnRecords[0]?.child;
		await waitForTeammateTerminal(teammateId);

		unreadPeerMessages = 2;
		sequence.length = 0;
		const resumed = await controller
			.createToolDefinition()
			.execute("call-resume", { action: "resume", teammateId }, undefined, undefined, createContext(tempDir));

		expect(resumed.details).toMatchObject({
			id: teammateId,
			status: "running",
			activity: "idle",
			sessionId: "teammate-session-id",
			sessionFile,
		});
		oldChild?.emit("close", 1, null);
		const afterLateClose = await controller
			.createToolDefinition()
			.execute(
				"call-status-after-late-close",
				{ action: "status", teammateId },
				undefined,
				undefined,
				createContext(tempDir),
			);
		expect(afterLateClose.details).toMatchObject({ status: "running", activity: "idle" });
		expect(spawnRecords).toHaveLength(2);
		expect(spawnRecords[1]?.args).toEqual(expect.arrayContaining(["--session", sessionFile]));
		expect(sequence).toEqual(["rpc:get_state", "peer:send"]);
		expect(peerMessages.at(-1)).toMatchObject({ to: "teammate-session-id", urgent: true });
		expect(peerMessages.at(-1)?.content).toContain("using send_message");
		expect(peerMessages.at(-1)?.content).not.toContain("urgent=true");
		expect(resumed.details).toMatchObject({ queuedMessages: 2 });
		expect(spawnRecords[1]?.args).not.toContain("--session-id");
	});

	it("preserves a direct Node/dist invocation prefix across start and resume", async () => {
		await controller.shutdown();
		controller = createControllerWithInvocation(
			createRpcSpawn(spawnRecords, sequence, () => sessionStatsResponseMode),
			(args) => ({ command: "/opt/node/bin/node", args: ["/repo/pi/coding-agent/dist/cli.js", ...args] }),
		);
		const started = await startTeammate();
		const teammateId = started.details?.id as string;

		await controller
			.createToolDefinition()
			.execute("call-stop-node-dist", { action: "stop", teammateId }, undefined, undefined, createContext(tempDir));
		await waitForTeammateTerminal(teammateId);
		await controller
			.createToolDefinition()
			.execute(
				"call-resume-node-dist",
				{ action: "resume", teammateId },
				undefined,
				undefined,
				createContext(tempDir),
			);

		expect(spawnRecords).toHaveLength(2);
		for (const record of spawnRecords) {
			expect(record.command).toBe("/opt/node/bin/node");
			expect(record.args[0]).toBe("/repo/pi/coding-agent/dist/cli.js");
			expect(record.args.slice(1)).toEqual(expect.arrayContaining(["--mode", "rpc", "--session"]));
		}
	});

	it("runs an editing teammate in a session-scoped worktree and integrates its receipt", async () => {
		const repo = join(tempDir, "repo");
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "--quiet");
		git(repo, "config", "user.email", "tests@example.com");
		git(repo, "config", "user.name", "Magenta Tests");
		writeFileSync(join(repo, "owned.txt"), "base\n");
		git(repo, "add", "owned.txt");
		git(repo, "commit", "--quiet", "-m", "base");

		const started = await controller.createToolDefinition().execute(
			"call-start-worktree",
			{
				action: "start",
				label: "worktree-editor",
				workspace: "worktree",
				message: "Edit only owned.txt",
			},
			undefined,
			undefined,
			createContext(repo),
		);
		const teammateId = started.details?.id as string;
		const assignmentId = started.details?.assignmentId as string;
		const workspace = started.details?.workspace as { path: string; collaborationRoot: string };
		expect(workspace.path).toContain(join(".magenta", "tmp", "collaboration", "parent-session-id"));
		writeFileSync(join(workspace.path, "owned.txt"), "from teammate\n");
		writeFileSync(join(workspace.path, "new.txt"), "new\n");

		emitRpcEvent({
			type: "tool_execution_end",
			toolName: "send_message",
			result: { details: { id: "terminal-worktree", assignmentId, terminalStatus: "completed" } },
		});
		await vi.waitFor(async () => {
			const status = await controller
				.createToolDefinition()
				.execute(
					"call-status-worktree",
					{ action: "status", teammateId },
					undefined,
					undefined,
					createContext(repo),
				);
			expect(status.details).toMatchObject({
				assignments: [expect.objectContaining({ assignmentId, assignmentStatus: "completed" })],
			});
		});
		await controller
			.createToolDefinition()
			.execute("call-stop-worktree", { action: "stop", teammateId }, undefined, undefined, createContext(repo));
		await waitForTeammateTerminal(teammateId);

		const integrated = await controller
			.createToolDefinition()
			.execute("call-integrate", { action: "integrate", teammateId }, undefined, undefined, createContext(repo));
		expect(integrated.details?.integration).toMatchObject({
			status: "applied",
			changedFiles: expect.arrayContaining(["new.txt", "owned.txt"]),
		});
		expect(readFileSync(join(repo, "owned.txt"), "utf8")).toBe("from teammate\n");
		expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new\n");
		expect(existsSync(workspace.path)).toBe(false);
		expect(existsSync(workspace.collaborationRoot)).toBe(true);
	});

	it("preserves an unintegrated worktree and receipt when the parent shuts down", async () => {
		const repo = join(tempDir, "shutdown-repo");
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "--quiet");
		git(repo, "config", "user.email", "tests@example.com");
		git(repo, "config", "user.name", "Magenta Tests");
		writeFileSync(join(repo, "owned.txt"), "base\n");
		git(repo, "add", "owned.txt");
		git(repo, "commit", "--quiet", "-m", "base");
		const started = await controller
			.createToolDefinition()
			.execute(
				"call-start-shutdown-worktree",
				{ action: "start", workspace: "worktree", label: "preserved-editor" },
				undefined,
				undefined,
				createContext(repo),
			);
		const workspace = started.details?.workspace as { path: string; manifestPath: string };
		writeFileSync(join(workspace.path, "owned.txt"), "unintegrated\n");

		await controller.shutdown();
		expect(existsSync(workspace.path)).toBe(true);
		const manifest = JSON.parse(readFileSync(workspace.manifestPath, "utf8")) as {
			state: string;
			receipt?: { patchPath: string; changedFiles: string[] };
		};
		expect(manifest.state).toBe("terminal_unintegrated");
		expect(manifest.receipt?.changedFiles).toContain("owned.txt");
		expect(existsSync(manifest.receipt?.patchPath ?? "")).toBe(true);
	});

	it("reports status, stops the persistent host, and retains the saved session", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		const sessionFile = started.details?.sessionFile as string;

		const listed = await controller
			.createToolDefinition()
			.execute("call-list", { action: "status" }, undefined, undefined, createContext(tempDir));
		expect(textOf(listed)).toContain("teammate_001\trunning\tidle\tshared\tno-assignment\treviewer");

		sequence.length = 0;
		const stopping = await controller
			.createToolDefinition()
			.execute("call-stop", { action: "stop", teammateId }, undefined, undefined, createContext(tempDir));
		expect(sequence).toEqual(["rpc:abort"]);
		expect(stopping.details).toMatchObject({
			id: teammateId,
			status: "running",
			activity: "stopping",
			sessionId: "teammate-session-id",
		});
		await waitForTeammateTerminal(teammateId);
		const stopped = await controller
			.createToolDefinition()
			.execute(
				"call-status-stopped",
				{ action: "status", teammateId },
				undefined,
				undefined,
				createContext(tempDir),
			);
		expect(stopped.details).toMatchObject({ id: teammateId, status: "stopped", sessionId: "teammate-session-id" });
		expect(peerMessages.at(-1)).toMatchObject({ to: "parent-session-id", urgent: true });
		expect(peerMessages.at(-1)?.content).toContain("[managed teammate terminal]");
		expect(existsSync(sessionFile)).toBe(true);
		expect(readFileSync(sessionFile, "utf8")).toContain("magenta-teammate-identity");
		await expect(
			controller
				.createToolDefinition()
				.execute(
					"call-send-stopped",
					{ action: "send", teammateId, message: "too late" },
					undefined,
					undefined,
					createContext(tempDir),
				),
		).rejects.toThrow("Cannot send: teammate teammate_001 is stopped");
	});
});
