import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { BackgroundEventManager } from "../src/core/background-events.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SubAgentController, type SubAgentReturnMessage, type SubAgentSpawn } from "../src/core/tools/sub-agent.ts";

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

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

type SpawnRecord = {
	command: string;
	args: string[];
	options: SpawnOptions;
	child: ChildProcess & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
};

function createFakeSpawn(records: SpawnRecord[], options?: { autoClose?: boolean; output?: string }): SubAgentSpawn {
	return (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcess => {
		const child = new EventEmitter() as SpawnRecord["child"];
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.pid = 999999;
		child.kill = vi.fn(() => true);
		records.push({ command, args, options: spawnOptions, child });
		if (options?.autoClose !== false) {
			setTimeout(() => {
				child.stdout.emit("data", Buffer.from(options?.output ?? "sub-agent output"));
				child.emit("close", 0, null);
			}, 5);
		}
		return child;
	};
}

describe("built-in sub_agent tool", () => {
	let tempDir: string;
	let manager: BackgroundEventManager;
	let controller: SubAgentController;
	let returned: SubAgentReturnMessage[];
	let spawnRecords: SpawnRecord[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sub-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		manager = new BackgroundEventManager();
		returned = [];
		spawnRecords = [];
		controller = new SubAgentController(manager, {
			sendMessage: (message, options) => {
				returned.push({ message, options });
			},
			spawnAgent: createFakeSpawn(spawnRecords, { output: "sub-result" }),
		});
	});

	afterEach(() => {
		controller.shutdown();
		manager.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("starts, waits for, and returns a completed sub-agent", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		controller.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "src/file.ts" },
		} as AgentSessionEvent);

		const start = await tool.execute(
			"call-start",
			{
				action: "start",
				task: "Inspect the file",
				role: "reviewer",
				returnToMain: true,
				returnDelivery: "nextTurn",
			},
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		const promptPath = start.details?.promptPath as string;

		expect(eventId).toMatch(/^agent_/);
		expect(spawnRecords[0]?.command).toBe("pi");
		expect(spawnRecords[0]?.args).toEqual(
			expect.arrayContaining(["--print", "--no-session", "--no-extensions", "--tools", "read,grep,find,ls"]),
		);
		expect(spawnRecords[0]?.options.cwd).toBe(tempDir);
		expect((spawnRecords[0]?.options.env as NodeJS.ProcessEnv).PI_SUB_AGENT).toBe("1");
		expect(readFileSync(promptPath, "utf8")).toContain("read (running");
		expect(readFileSync(promptPath, "utf8")).toContain("Inspect the file");

		const waited = await tool.execute(
			"call-wait",
			{ action: "wait", eventId, waitTimeoutSeconds: 5 },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(waited)).toContain("Status: exited");
		expect(textOf(waited)).toContain("sub-result");

		await waitUntil(() => returned.length === 1);
		expect(returned[0]?.message.customType).toBe("sub-agent-return");
		expect(returned[0]?.message.content).toContain("sub-result");
		expect(returned[0]?.message.details).toMatchObject({ ids: [eventId], statuses: ["exited"] });
		expect(returned[0]?.options).toMatchObject({ deliverAs: "nextTurn", triggerTurn: false });
	});

	it("starts multiple sub-agents concurrently", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-start",
			{
				action: "start",
				tasks: [
					{ task: "Inspect tests", label: "tests" },
					{ task: "Inspect docs", label: "docs" },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(textOf(start)).toContain("Started 2 sub-agents concurrently");
		expect(start.details?.ids).toHaveLength(2);
		expect(spawnRecords).toHaveLength(2);
	});

	it("cancels a running sub-agent", async () => {
		controller = new SubAgentController(manager, {
			sendMessage: (message, options) => {
				returned.push({ message, options });
			},
			spawnAgent: createFakeSpawn(spawnRecords, { autoClose: false }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-start",
			{ action: "start", task: "Long analysis" },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;

		const cancelled = await tool.execute("call-cancel", { action: "cancel", eventId }, undefined, undefined, ctx);
		expect(textOf(cancelled)).toContain(`${eventId} cancelled`);

		const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
		expect(textOf(status)).toContain("Status: cancelled");
	});

	it("updates session defaults with config action", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const result = await tool.execute(
			"call-config",
			{
				action: "config",
				defaultTimeoutSeconds: 1,
				defaultWaitTimeoutSeconds: 2,
				defaultReturnToMain: true,
				defaultReturnDelivery: "nextTurn",
				defaultThinking: "high",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(textOf(result)).toContain("defaultTimeoutSeconds: 1");
		expect(textOf(result)).toContain("defaultWaitTimeoutSeconds: 2");
		expect(textOf(result)).toContain("defaultReturnToMain: true");
		expect(textOf(result)).toContain("defaultReturnDelivery: nextTurn");
		expect(textOf(result)).toContain("defaultThinking: high");
	});
});
