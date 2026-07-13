import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundEventManager } from "../src/core/background-events.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SendMessageInput } from "../src/core/tools/send-message.ts";
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

function createRpcSpawn(records: SpawnRecord[], sequence: string[]): TeammateAgentSpawn {
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
					const response =
						request.type === "get_state"
							? {
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
								}
							: { id: request.id, type: "response", command: request.type, success: true };
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
	let peerMessages: SendMessageInput[];
	let spawnRecords: SpawnRecord[];
	let sequence: string[];
	let unreadPeerMessages: number;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-teammate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		parentSession = SessionManager.create(tempDir, tempDir, { id: "parent-session-id" });
		parentSession.appendSessionInfo("parent");
		parentSession.flush();
		parentSessionFile = parentSession.getSessionFile()!;
		manager = new BackgroundEventManager();
		peerMessages = [];
		spawnRecords = [];
		sequence = [];
		unreadPeerMessages = 0;
		controller = new TeammateAgentController(manager, {
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
			spawnAgent: createRpcSpawn(spawnRecords, sequence),
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
		expect(context).toContain("urgent=true so an idle parent wakes");

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
		expect(textOf(started)).toContain("first assignment was delivered through send_message");
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
		expect(peerMessages).toHaveLength(2);
		expect(peerMessages[0]).toMatchObject({ to: "teammate-session-id", urgent: true });
		expect(peerMessages[0]?.content).toContain("Inspect the parser");
		expect(peerMessages[0]?.content).toContain("replyTargetSessionId: parent-session-id");
		expect(peerMessages[0]?.content).toContain("urgent=true");
		expect(peerMessages[1]).toMatchObject({ to: "teammate-session-id", urgent: false });
		expect(spawnRecords).toHaveLength(1);
		expect(spawnRecords[0]?.commands).toEqual(["get_state"]);
		expect(sequence).toEqual(["peer:send", "peer:send"]);
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
		expect(resumed.details).toMatchObject({ queuedMessages: 2 });
		expect(spawnRecords[1]?.args).not.toContain("--session-id");
	});

	it("reports status, stops the persistent host, and retains the saved session", async () => {
		const started = await startTeammate();
		const teammateId = started.details?.id as string;
		const sessionFile = started.details?.sessionFile as string;

		const listed = await controller
			.createToolDefinition()
			.execute("call-list", { action: "status" }, undefined, undefined, createContext(tempDir));
		expect(textOf(listed)).toContain("teammate_001\trunning\tidle\tteammate-session-id\treviewer");

		sequence.length = 0;
		const stopped = await controller
			.createToolDefinition()
			.execute("call-stop", { action: "stop", teammateId }, undefined, undefined, createContext(tempDir));
		expect(sequence).toEqual(["rpc:abort"]);
		expect(stopped.details).toMatchObject({ id: teammateId, status: "stopped", sessionId: "teammate-session-id" });
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
