import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiAgentOrchestrator } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentInvocation } from "../src/config.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { BackgroundEventManager } from "../src/core/background-events.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	buildOrchestrationRequest,
	SubAgentController,
	type SubAgentEventSnapshot,
	type SubAgentReturnMessage,
	type SubAgentSpawn,
	type SubAgentWorkflowProvider,
	sanitizeSubAgentTools,
} from "../src/core/tools/sub-agent.ts";

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
		Object.assign(child, {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			pid: 999999,
		});
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

describe("sub-agent tool grants", () => {
	it("strips nested agent and background controllers", () => {
		expect(sanitizeSubAgentTools(["read", "sub_agent", "bg_shell", "teammate_agent", "ls"])).toEqual(["read", "ls"]);
	});

	it("falls back to read-only tools when only forbidden controllers were requested", () => {
		expect(sanitizeSubAgentTools(["sub_agent", "bg_shell", "teammate_agent"])).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
	});
});

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
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
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

	it("describes sessionless one-shot workers and exposes only runtime-owned workflow presets", () => {
		const tool = controller.createToolDefinition();
		expect(tool.description).toContain("sessionless, one-shot");
		expect(tool.description).toContain("fixed runtime-owned control flow");
		expect(tool.description).not.toContain("script");
		const workflowSchema = (tool.parameters as any).properties.workflow;
		expect(JSON.stringify(workflowSchema)).not.toContain('"script"');
		expect(workflowSchema.properties.script).toBeUndefined();
		expect(workflowSchema.properties.args).toBeUndefined();
		expect(tool.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("bounded one-shot work"),
				expect.stringContaining("retained context"),
				expect.stringContaining("soft lease"),
				expect.stringContaining("non-overlapping Todo work"),
				expect.stringContaining("analysis scope, not files"),
				expect.stringContaining("not a runtime lock"),
				expect.stringContaining("confirm the event is terminal"),
				expect.stringContaining("fixed runtime-owned control flow"),
			]),
		);
	});

	it("action=wait consumes results inline and cancels the pending auto-return", async () => {
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

		expect(textOf(start)).toContain("Delegation soft lease active for each running event");
		expect(textOf(start)).toContain("do not duplicate its scope");
		expect(textOf(start)).toContain("independently verify it");
		expect(eventId).toMatch(/^agent_/);
		expect(spawnRecords[0]?.command).toBe(getAgentInvocation([]).command);
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
		expect(manager.getEvents().find((event) => event.id === eventId)).toMatchObject({
			lastActivityAt: expect.any(Number),
			lastOutputAt: expect.any(Number),
			activityPhase: "agent",
			reminderEligible: false,
		});

		// Because the model synchronously waited for (and was shown) the result,
		// the pending returnToMain auto-delivery must be cancelled: no duplicate
		// "[sub-agent-return]" message and no extra triggered turn.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(returned).toHaveLength(0);
	});

	it("keeps interleaved stdout and stderr UTF-8 state independent in the tail and log", async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { autoClose: false }),
			workDirRoot: join(tempDir, "utf8"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-utf8",
			{ action: "start", task: "emit unicode", returnToMain: false },
			undefined,
			undefined,
			ctx,
		);
		const stdoutText = "前缀🙂中文结尾";
		const bytes = Buffer.from(stdoutText, "utf8");
		spawnRecords[0]?.child.stdout.emit("data", bytes.subarray(0, 1));
		spawnRecords[0]?.child.stderr.emit("data", Buffer.from("stderr-ascii|"));
		let offset = 1;
		for (const boundary of [3, 6, 8, 11, bytes.length]) {
			spawnRecords[0]?.child.stdout.emit("data", bytes.subarray(offset, boundary));
			offset = boundary;
		}
		spawnRecords[0]?.child.emit("close", 0, null);

		const status = await tool.execute(
			"call-utf8-status",
			{ action: "status", eventId: start.details?.id as string },
			undefined,
			undefined,
			ctx,
		);
		const expected = `stderr-ascii|${stdoutText}`;
		const event = (controller as unknown as { events: Map<string, { tail: string }> }).events.get(
			start.details?.id as string,
		);
		expect(event?.tail).toBe(expected);
		expect(textOf(status)).toContain(expected);
		expect(textOf(status)).not.toContain("�");

		const logPath = start.details?.logPath as string;
		await waitUntil(() => readFileSync(logPath, "utf8").split("\n\n").slice(1).join("\n\n").includes(expected));
		const loggedOutput = readFileSync(logPath, "utf8").split("\n\n").slice(1).join("\n\n");
		expect(loggedOutput).toContain(expected);
		expect(loggedOutput).not.toContain("�");
	});

	it("serializes parent progress writes so the newest snapshot wins", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		controller.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "progress-call",
			toolName: "bash",
			args: { command: "test" },
		} as AgentSessionEvent);
		controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "progress-call",
			toolName: "bash",
			args: { command: "test" },
			partialResult: { content: "old snapshot" },
		} as AgentSessionEvent);
		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "progress-call",
			toolName: "bash",
			result: { content: "newest snapshot" },
			isError: false,
		} as AgentSessionEvent);

		const start = await tool.execute(
			"call-progress-reader",
			{ action: "start", task: "Read progress", returnToMain: false },
			undefined,
			undefined,
			ctx,
		);
		const progress = readFileSync(start.details?.parentProgressPath as string, "utf8");
		expect(progress).toContain("bash (finished");
		expect(progress).toContain("newest snapshot");
		expect(progress).not.toContain("latest update: old snapshot");
	});

	it("returnToMain without waiting delivers results to the main agent once", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute(
			"call-start",
			{ action: "start", task: "Inspect the file", returnToMain: true },
			undefined,
			undefined,
			ctx,
		);

		// No wait/status this turn, so the auto-return is the only delivery path.
		await waitUntil(() => returned.length === 1);
		expect(returned[0]?.message.customType).toBe("sub-agent-return");
		expect(returned[0]?.message.content).toContain("soft lease is released");
		expect(returned[0]?.message.content).toContain("independently verify them");
		expect(returned[0]?.message.content).toContain("sub-result");
		// Default delivery is followUp, which triggers a continuation turn.
		expect(returned[0]?.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });

		// Exactly one delivery — it must not fire again.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(returned).toHaveLength(1);
	});

	it("bounds model-visible return output while retaining the full expandable snapshot", async () => {
		controller.shutdown();
		const largeOutput = `${"x".repeat(20_000)}TAIL-MARKER`;
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: largeOutput }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute(
			"call-start-large",
			{ action: "start", task: "Return a large result", returnToMain: true },
			undefined,
			undefined,
			ctx,
		);
		await waitUntil(() => returned.length === 1);

		const returnedMessage = returned[0]?.message;
		expect(Buffer.byteLength(returnedMessage?.content ?? "", "utf8")).toBeLessThan(12 * 1024);
		expect(returnedMessage?.content).toContain("TAIL-MARKER");
		expect(returnedMessage?.content).toContain("Output shortened");
		const eventData = (returnedMessage?.details as { eventData?: SubAgentEventSnapshot[] } | undefined)?.eventData;
		expect(Buffer.byteLength(eventData?.[0]?.tail ?? "", "utf8")).toBeGreaterThan(20_000);
	});

	it("caps each independently cancellable batch return including huge tasks and instructions", async () => {
		controller.shutdown();
		const largeOutput = `${"o".repeat(20_000)}AGGREGATE-TAIL`;
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: largeOutput }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const tasks = Array.from({ length: 8 }, (_, index) => ({
			task: `task-${index}-${"t".repeat(20_000)}`,
			label: `label-${index}-${"l".repeat(10_000)}`,
		}));

		await tool.execute(
			"call-start-many-large",
			{
				action: "start",
				tasks,
				returnToMain: true,
				returnInstruction: `instruction-${"i".repeat(40_000)}`,
			},
			undefined,
			undefined,
			ctx,
		);
		await waitUntil(() => returned.length === 8);

		for (const returnedMessage of returned.map((entry) => entry.message)) {
			expect(Buffer.byteLength(returnedMessage.content, "utf8")).toBeLessThanOrEqual(32 * 1024);
			expect(returnedMessage.content).toContain("Model-visible result shortened");
			const details = returnedMessage.details as {
				instruction?: string;
				eventData?: SubAgentEventSnapshot[];
			};
			expect(Buffer.byteLength(details.instruction ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
			expect(details.eventData).toHaveLength(1);
			expect(details.eventData?.[0]?.tail).toContain("AGGREGATE-TAIL");
		}
		expect(
			new Set(returned.flatMap((entry) => ((entry.message.details as { ids?: string[] }).ids ?? []).map((id) => id)))
				.size,
		).toBe(8);
	});

	it("preserves a direct Node/dist invocation prefix", async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: "sub-result" }),
			resolveAgentInvocation: (args) => ({
				command: "/opt/node/bin/node",
				args: ["/repo/pi/coding-agent/dist/cli.js", ...args],
			}),
		});
		const tool = controller.createToolDefinition();

		await tool.execute(
			"call-node-dist",
			{ action: "start", task: "Inspect current changes", returnToMain: false },
			undefined,
			undefined,
			createContext(tempDir),
		);

		expect(spawnRecords[0]?.command).toBe("/opt/node/bin/node");
		expect(spawnRecords[0]?.args[0]).toBe("/repo/pi/coding-agent/dist/cli.js");
		expect(spawnRecords[0]?.args.slice(1)).toEqual(
			expect.arrayContaining(["--print", "--no-session", "--no-extensions"]),
		);
	});

	it('inherits the parent model when a task omits model or uses "default"', async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: "sub-result" }),
			getDefaultModel: () => ({ provider: "anthropic", model: "claude-opus-4-8" }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute("call-start", { action: "start", task: "Review current changes" }, undefined, undefined, ctx);
		await tool.execute(
			"call-start-default",
			{ action: "start", task: "Review current changes again", model: "default" },
			undefined,
			undefined,
			ctx,
		);

		for (const record of spawnRecords) {
			expect(record.command).toBe(getAgentInvocation([]).command);
			expect(record.args).toEqual(expect.arrayContaining(["--provider", "anthropic", "--model", "claude-opus-4-8"]));
			expect(record.args).not.toContain("default");
		}
	});

	it("uses an explicit task model instead of inheriting the parent model", async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: "sub-result" }),
			getDefaultModel: () => ({ provider: "anthropic", model: "claude-opus-4-8" }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute(
			"call-start",
			{ action: "start", task: "Review current changes", provider: "openai", model: "gpt-5.4" },
			undefined,
			undefined,
			ctx,
		);

		expect(spawnRecords[0]?.args).toEqual(expect.arrayContaining(["--provider", "openai", "--model", "gpt-5.4"]));
		expect(spawnRecords[0]?.args).not.toEqual(expect.arrayContaining(["claude-opus-4-8"]));
	});

	it("passes granted packages as --harness-package args", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute(
			"call-start",
			{ action: "start", task: "Analyze the paper", packages: ["paper-analysis", "pptx"] },
			undefined,
			undefined,
			ctx,
		);

		const args = spawnRecords[0]?.args ?? [];
		expect(args).toEqual(expect.arrayContaining(["--harness-package", "paper-analysis"]));
		expect(args).toEqual(expect.arrayContaining(["--harness-package", "pptx"]));
		// Two selectors → two --harness-package flags.
		expect(args.filter((a) => a === "--harness-package")).toHaveLength(2);
	});

	it("does not add --harness-package when no packages are granted", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute("call-start", { action: "start", task: "Plain task" }, undefined, undefined, ctx);

		expect(spawnRecords[0]?.args).not.toEqual(expect.arrayContaining(["--harness-package"]));
	});

	it("grants top-level packages to every task unless a task overrides them", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		await tool.execute(
			"call-start",
			{
				action: "start",
				packages: [" shared-package "],
				tasks: [{ task: "Use the shared package" }, { task: "Use an override", packages: ["task-package"] }],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(spawnRecords[0]?.args).toEqual(expect.arrayContaining(["--harness-package", "shared-package"]));
		expect(spawnRecords[1]?.args).toEqual(expect.arrayContaining(["--harness-package", "task-package"]));
		expect(spawnRecords[1]?.args).not.toEqual(expect.arrayContaining(["shared-package"]));
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
		expect(textOf(start)).toContain("Delegation soft lease active for each running event");
		expect(textOf(start)).toContain("Continue only non-overlapping work");
		expect(start.details?.ids).toHaveLength(2);
		expect(spawnRecords).toHaveLength(2);
	});

	it("keeps batch auto-returns independently cancellable per event", async () => {
		controller.shutdown();
		const cancelledReturnIds: string[][] = [];
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: (ids) => cancelledReturnIds.push(ids),
			spawnAgent: createFakeSpawn(spawnRecords, { autoClose: false }),
			workDirRoot: join(tempDir, "partial-return"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-batch-return",
			{
				action: "start",
				tasks: [{ task: "first" }, { task: "second" }],
				returnToMain: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const [firstId, secondId] = start.details?.ids as string[];

		const waitingForFirst = tool.execute(
			"call-wait-first",
			{ action: "wait", eventId: firstId, waitTimeoutSeconds: 1 },
			undefined,
			undefined,
			ctx,
		);
		spawnRecords[0]?.child.emit("close", 0, null);
		await waitingForFirst;
		await Promise.resolve();
		expect(cancelledReturnIds).toContainEqual([firstId]);
		expect(returned).toHaveLength(0);

		spawnRecords[1]?.child.emit("close", 0, null);
		await waitUntil(() => returned.length === 1);
		expect((returned[0]?.message.details as { ids?: string[] }).ids).toEqual([secondId]);
		expect(returned[0]?.message.content).toContain("second");
		expect(returned[0]?.message.content).not.toContain("Sub-agent: agent_001");
	});

	it("rejects already-aborted and shutdown-interrupted starts before spawning", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const aborted = new AbortController();
		aborted.abort();
		await expect(
			tool.execute("call-aborted", { action: "start", task: "must not run" }, aborted.signal, undefined, ctx),
		).rejects.toThrow(/aborted/);
		expect(spawnRecords).toHaveLength(0);

		const abortDuringStart = new AbortController();
		const aborting = tool.execute(
			"call-abort-during-start",
			{ action: "start", task: "abort during startup" },
			abortDuringStart.signal,
			undefined,
			ctx,
		);
		abortDuringStart.abort();
		await expect(aborting).rejects.toThrow(/aborted/);
		expect(spawnRecords).toHaveLength(0);

		const starting = tool.execute(
			"call-shutdown",
			{ action: "start", task: "also must not run" },
			undefined,
			undefined,
			ctx,
		);
		controller.shutdown();
		// A subsequent session start must not revive startup work interrupted by
		// the prior shutdown generation.
		controller.handleAgentEvent({ type: "agent_start" } as AgentSessionEvent);
		await expect(starting).rejects.toThrow(/shutting down|interrupted/);
		expect(spawnRecords).toHaveLength(0);
	});

	it("enforces the eight-event cap across concurrent start calls", async () => {
		const records: SpawnRecord[] = [];
		const limited = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(records, { autoClose: false }),
			workDirRoot: join(tempDir, "limit"),
		});
		try {
			const tool = limited.createToolDefinition();
			const ctx = createContext(tempDir);
			const settled = await Promise.allSettled(
				Array.from({ length: 9 }, (_, index) =>
					tool.execute(
						`call-concurrent-${index}`,
						{ action: "start", task: `task ${index}`, returnToMain: false },
						undefined,
						undefined,
						ctx,
					),
				),
			);
			expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(8);
			expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
			expect(records).toHaveLength(8);
			const internals = limited as unknown as {
				events: Map<string, { status: string }>;
				reservedStarts: number;
			};
			const running = [...internals.events.values()].filter((event) => event.status === "running").length;
			expect(running).toBe(8);
			expect(running + internals.reservedStarts).toBeLessThanOrEqual(8);
			expect(internals.reservedStarts).toBe(0);
		} finally {
			limited.shutdown();
		}
	});

	it("converges already-started batch members when a later spawn fails", async () => {
		const records: SpawnRecord[] = [];
		const fakeSpawn = createFakeSpawn(records, { autoClose: false });
		let calls = 0;
		const partial = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: (command, args, options) => {
				calls += 1;
				if (calls === 2) throw new Error("spawn failed");
				return fakeSpawn(command, args, options);
			},
			workDirRoot: join(tempDir, "partial"),
		});
		try {
			const tool = partial.createToolDefinition();
			await expect(
				tool.execute(
					"call-partial",
					{ action: "start", tasks: [{ task: "first" }, { task: "second" }], returnToMain: false },
					undefined,
					undefined,
					createContext(tempDir),
				),
			).rejects.toThrow("spawn failed");
			expect(records).toHaveLength(1);
			expect(records[0]?.child.kill).toHaveBeenCalled();
			const events = (partial as unknown as { events: Map<string, { status: string }> }).events;
			const event = [...events.values()][0];
			expect(event?.status).toBe("terminating");
			records[0]?.child.emit("close", null, "SIGTERM");
			expect(event?.status).toBe("cancelled");
		} finally {
			partial.shutdown();
		}
	});

	it("isolates filesystem paths across controllers created at the same time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
		const managerA = new BackgroundEventManager();
		const managerB = new BackgroundEventManager();
		const recordsA: SpawnRecord[] = [];
		const recordsB: SpawnRecord[] = [];
		const sharedRoot = join(tempDir, "shared-root");
		const controllerA = new SubAgentController(managerA, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(recordsA, { autoClose: false }),
			workDirRoot: sharedRoot,
		});
		const controllerB = new SubAgentController(managerB, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(recordsB, { autoClose: false }),
			workDirRoot: sharedRoot,
		});
		try {
			const [startA, startB] = await Promise.all([
				controllerA
					.createToolDefinition()
					.execute(
						"call-a",
						{ action: "start", task: "A", returnToMain: false },
						undefined,
						undefined,
						createContext(tempDir),
					),
				controllerB
					.createToolDefinition()
					.execute(
						"call-b",
						{ action: "start", task: "B", returnToMain: false },
						undefined,
						undefined,
						createContext(tempDir),
					),
			]);
			expect(startA.details?.promptPath).not.toBe(startB.details?.promptPath);
			expect(startA.details?.logPath).not.toBe(startB.details?.logPath);
			expect(startA.details?.parentProgressPath).not.toBe(startB.details?.parentProgressPath);
			expect(readFileSync(startA.details?.promptPath as string, "utf8")).toContain(
				startA.details?.parentProgressPath as string,
			);
			expect(readFileSync(startB.details?.promptPath as string, "utf8")).toContain(
				startB.details?.parentProgressPath as string,
			);
		} finally {
			controllerA.shutdown();
			controllerB.shutdown();
			managerA.dispose();
			managerB.dispose();
			vi.useRealTimers();
		}
	});

	it("rejects startup when its controller filesystem namespace cannot be created", async () => {
		const blockedRoot = join(tempDir, "not-a-directory");
		writeFileSync(blockedRoot, "blocked", "utf8");
		const records: SpawnRecord[] = [];
		const blocked = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(records),
			workDirRoot: blockedRoot,
		});
		try {
			await expect(
				blocked
					.createToolDefinition()
					.execute(
						"call-blocked",
						{ action: "start", task: "must reject" },
						undefined,
						undefined,
						createContext(tempDir),
					),
			).rejects.toThrow();
			expect(records).toHaveLength(0);
		} finally {
			blocked.shutdown();
		}
	});

	it("cancels a running sub-agent", async () => {
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
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
		expect(textOf(cancelled)).toContain(`${eventId} cancellation requested`);
		expect(textOf(cancelled)).toContain("soft lease remains active");

		const terminating = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
		expect(textOf(terminating)).toContain("Status: terminating");
		expect(returned).toHaveLength(0);

		spawnRecords[0]?.child.emit("close", null, "SIGTERM");
		const status = await tool.execute("call-status-done", { action: "status", eventId }, undefined, undefined, ctx);
		expect(textOf(status)).toContain("Status: cancelled");
		const internalEvent = (
			controller as unknown as {
				events: Map<string, { graceKillTimer?: NodeJS.Timeout }>;
			}
		).events.get(eventId);
		expect(internalEvent?.graceKillTimer).toBeUndefined();
	});

	it("retains a pid-bearing child when SIGTERM emits error synchronously until close settles it", async () => {
		controller.shutdown();
		const records: SpawnRecord[] = [];
		const baseSpawn = createFakeSpawn(records, { autoClose: false });
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: (command, args, options) => {
				const child = baseSpawn(command, args, options) as SpawnRecord["child"];
				child.kill = vi.fn(() => {
					child.emit("error", new Error("kill ESRCH"));
					return false;
				});
				return child;
			},
			workDirRoot: join(tempDir, "sync-kill-error"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-sync-kill-error",
			{ action: "start", task: "remain alive", returnToMain: false },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		await tool.execute("call-sync-kill-cancel", { action: "cancel", eventId }, undefined, undefined, ctx);

		const active = (
			controller as unknown as {
				events: Map<
					string,
					{
						status: string;
						child?: ChildProcess;
						graceKillTimer?: NodeJS.Timeout;
						terminationRequest?: { status: string };
					}
				>;
			}
		).events.get(eventId);
		expect(active).toMatchObject({
			status: "terminating",
			child: records[0]?.child,
			graceKillTimer: expect.anything(),
			terminationRequest: { status: "cancelled" },
		});

		records[0]?.child.emit("close", null, "SIGTERM");
		expect(active).toMatchObject({ status: "cancelled", graceKillTimer: undefined, child: undefined });
	});

	it("preserves immediate terminal failure for a spawn error without a pid", async () => {
		controller.shutdown();
		const records: SpawnRecord[] = [];
		const baseSpawn = createFakeSpawn(records, { autoClose: false });
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: (command, args, options) => {
				const child = baseSpawn(command, args, options) as SpawnRecord["child"];
				Object.defineProperty(child, "pid", { value: undefined });
				return child;
			},
			workDirRoot: join(tempDir, "spawn-error"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-spawn-error",
			{ action: "start", task: "fail to spawn", returnToMain: false },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		records[0]?.child.emit("error", new Error("spawn ENOENT"));

		const status = await tool.execute(
			"call-spawn-error-status",
			{ action: "status", eventId },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(status)).toContain("Status: failed");
		expect(textOf(status)).toContain("spawn ENOENT");
		const event = (
			controller as unknown as { events: Map<string, { status: string; child?: ChildProcess }> }
		).events.get(eventId);
		expect(event).toMatchObject({ status: "failed", child: undefined });
	});

	it("clears the grace escalation timer when a terminated child closes", async () => {
		const clearTimer = vi.spyOn(globalThis, "clearTimeout");
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { autoClose: false }),
			workDirRoot: join(tempDir, "grace-clear"),
		});
		try {
			const tool = controller.createToolDefinition();
			const ctx = createContext(tempDir);
			const start = await tool.execute(
				"call-grace-clear",
				{ action: "start", task: "close after term", returnToMain: false },
				undefined,
				undefined,
				ctx,
			);
			await tool.execute(
				"call-grace-cancel",
				{ action: "cancel", eventId: start.details?.id as string },
				undefined,
				undefined,
				ctx,
			);
			const active = (
				controller as unknown as {
					events: Map<string, { status: string; graceKillTimer?: NodeJS.Timeout }>;
				}
			).events.get(start.details?.id as string);
			const graceKillTimer = active?.graceKillTimer;
			expect(graceKillTimer).toBeDefined();
			spawnRecords[0]?.child.emit("close", null, "SIGTERM");
			expect(active).toMatchObject({ status: "cancelled", graceKillTimer: undefined });
			expect(clearTimer).toHaveBeenCalledWith(graceKillTimer);
		} finally {
			clearTimer.mockRestore();
		}
	});

	it("keeps timed-out children active until close and delays auto-return", async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { autoClose: false }),
			workDirRoot: join(tempDir, "delayed-timeout"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-delayed-timeout",
			{ action: "start", task: "ignore SIGTERM", timeoutSeconds: 0.01, returnToMain: true },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		await waitUntil(() => manager.getEvents().find((event) => event.id === eventId)?.status === "terminating");

		const terminating = await tool.execute(
			"call-timeout-status",
			{ action: "status", eventId },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(terminating)).toContain("Status: terminating");
		expect(returned).toHaveLength(0);
		await expect(
			tool.execute(
				"call-over-capacity-while-terminating",
				{ action: "start", tasks: Array.from({ length: 8 }, (_, index) => ({ task: `extra ${index}` })) },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/limit is 8/);

		spawnRecords[0]?.child.emit("close", null, "SIGKILL");
		await waitUntil(() => returned.length === 1);
		expect(returned[0]?.message.content).toContain("Status: timed_out");
		const internalEvent = (
			controller as unknown as {
				events: Map<string, { status: string; graceKillTimer?: NodeJS.Timeout }>;
			}
		).events.get(eventId);
		expect(internalEvent).toMatchObject({ status: "timed_out", graceKillTimer: undefined });
	});

	it("keeps shutdown cancellation nonterminal until the child closes", async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { autoClose: false }),
			workDirRoot: join(tempDir, "delayed-shutdown"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-before-shutdown",
			{ action: "start", task: "stay alive", returnToMain: true },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		controller.shutdown();

		const terminating = await tool.execute(
			"call-shutdown-status",
			{ action: "status", eventId },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(terminating)).toContain("Status: terminating");
		expect(returned).toHaveLength(0);
		spawnRecords[0]?.child.emit("close", null, "SIGTERM");
		const terminal = await tool.execute(
			"call-shutdown-terminal-status",
			{ action: "status", eventId },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(terminal)).toContain("Status: cancelled");
		expect(returned).toHaveLength(0);
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
				defaultThinking: "max",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(textOf(result)).toContain("defaultTimeoutSeconds: 1");
		expect(textOf(result)).toContain("defaultWaitTimeoutSeconds: 2");
		expect(textOf(result)).toContain("defaultReturnToMain: true");
		expect(textOf(result)).toContain("defaultReturnDelivery: nextTurn");
		expect(textOf(result)).toContain("defaultThinking: max");
	});

	it("removes workflow from the schema and rejects bypassed workflow calls when disabled", async () => {
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			isWorkflowEnabled: () => false,
		});
		const tool = controller.createToolDefinition();
		expect((tool.parameters as any).properties.workflow).toBeUndefined();
		await expect(
			tool.execute(
				"call-disabled-wf",
				{
					action: "start",
					workflow: {
						pattern: "fan_out_synthesize",
						workers: [{ task: "inspect" }],
						synthesizer: { task: "summarize" },
					},
				},
				undefined,
				undefined,
				createContext(tempDir),
			),
		).rejects.toThrow("workflows are disabled");
	});

	it("runs a workflow as one background event and returns a structured tree", async () => {
		const fakeRunner = {
			spawn: async (options: { workerId: string }) => ({
				workerId: options.workerId,
				text: `synth of ${options.workerId}`,
				durationMs: 1,
				success: true,
			}),
			parallel: async (specs: Array<{ workerId: string }>) =>
				specs.map((s) => ({ workerId: s.workerId, text: `did ${s.workerId}`, durationMs: 1, success: true })),
		};
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: "unused" }),
			getWorkflowProvider: () => new MultiAgentOrchestrator({ cwd: tempDir, runner: fakeRunner as never }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-wf",
			{
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					name: "triage",
					workers: [{ task: "look at A" }, { task: "look at B" }],
					synthesizer: { task: "merge findings" },
				},
			},
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(start)).toContain("Started workflow");
		expect(textOf(start)).toContain("Pattern: fan_out_synthesize");
		expect(textOf(start)).toContain("Delegation soft lease active for each running event");
		expect(textOf(start)).toContain("synthesize and independently verify it");
		const eventId = start.details?.id as string;

		// The orchestration runs in-process (fake runner), so no real child agent is spawned.
		// Wait for it to finish via the wait action.
		await tool.execute("call-wait", { action: "wait", eventId }, undefined, undefined, ctx);

		const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
		const text = textOf(status);
		expect(text).toContain("Status: exited");
		expect(text).toContain("pattern: fan_out_synthesize");
		expect(text).toContain("outcome");
	});

	it("applies action and configured default timeouts to workflows", async () => {
		const observedSignals: AbortSignal[] = [];
		const timeoutProvider: SubAgentWorkflowProvider = {
			orchestrate: (_request, signal) =>
				new Promise((_resolve, reject) => {
					if (!signal) return;
					observedSignals.push(signal);
					signal.addEventListener("abort", () => reject(new Error("workflow aborted")), { once: true });
				}),
		};
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			getWorkflowProvider: () => timeoutProvider,
			workDirRoot: join(tempDir, "workflow-timeout"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const actionTimed = await tool.execute(
			"call-action-timeout",
			{
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					workers: [{ task: "inspect" }],
					synthesizer: { task: "summarize" },
				},
				timeoutSeconds: 0.01,
				returnToMain: false,
			},
			undefined,
			undefined,
			ctx,
		);
		const actionId = actionTimed.details?.id as string;
		const actionWait = await tool.execute(
			"call-action-wait",
			{ action: "wait", eventId: actionId, waitTimeoutSeconds: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(actionWait)).toContain("Status: timed_out");

		await tool.execute(
			"call-timeout-config",
			{ action: "config", defaultTimeoutSeconds: 0.01 },
			undefined,
			undefined,
			ctx,
		);
		const defaultTimed = await tool.execute(
			"call-default-timeout",
			{
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					workers: [{ task: "inspect" }],
					synthesizer: { task: "summarize" },
				},
				returnToMain: false,
			},
			undefined,
			undefined,
			ctx,
		);
		const defaultId = defaultTimed.details?.id as string;
		const defaultWait = await tool.execute(
			"call-default-wait",
			{ action: "wait", eventId: defaultId, waitTimeoutSeconds: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(defaultWait)).toContain("Status: timed_out");
		expect(observedSignals).toHaveLength(2);
		expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
		const events = (
			controller as unknown as {
				events: Map<string, { abort?: AbortController; timeout?: NodeJS.Timeout }>;
			}
		).events;
		expect(events.get(actionId)?.abort).toBeUndefined();
		expect(events.get(actionId)?.timeout).toBeUndefined();
		expect(events.get(defaultId)?.abort).toBeUndefined();
		expect(events.get(defaultId)?.timeout).toBeUndefined();
	});

	it("keeps an abort-ignoring workflow active until the provider settles", async () => {
		let settleWorkflow!: (result: { pattern: "fan_out_synthesize"; workers: []; terminatedBy: "completed" }) => void;
		const provider: SubAgentWorkflowProvider = {
			orchestrate: () =>
				new Promise((resolve) => {
					settleWorkflow = resolve;
				}),
		};
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			getWorkflowProvider: () => provider,
			workDirRoot: join(tempDir, "workflow-ignore-abort"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-ignore-abort",
			{
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					workers: [{ task: "inspect" }],
					synthesizer: { task: "summarize" },
				},
				timeoutSeconds: 0.01,
				returnToMain: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		await waitUntil(() => manager.getEvents().find((event) => event.id === eventId)?.status === "terminating");
		expect(returned).toHaveLength(0);

		settleWorkflow({ pattern: "fan_out_synthesize", workers: [], terminatedBy: "completed" });
		await waitUntil(() => returned.length === 1);
		expect(returned[0]?.message.content).toContain("Status: timed_out");
	});

	it("marks provider-reported workflow failures as failed", async () => {
		let call = 0;
		const failedOutcome = {
			pattern: "fan_out_synthesize" as const,
			workers: [],
			outcome: {
				workerId: "synthesizer",
				text: "",
				durationMs: 1,
				success: false,
				error: "synthesis failed",
			},
			terminatedBy: "completed" as const,
		};
		const overallFailure = {
			pattern: "fan_out_synthesize" as const,
			workers: [],
			terminatedBy: "completed" as const,
			success: false,
		};
		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			getWorkflowProvider: () => ({
				orchestrate: async () => (call++ === 0 ? failedOutcome : overallFailure) as never,
			}),
			workDirRoot: join(tempDir, "workflow-failure"),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		for (const expectedError of ["synthesis failed", "Workflow reported failure"]) {
			const start = await tool.execute(
				`call-failed-${call}`,
				{
					action: "start",
					workflow: {
						pattern: "fan_out_synthesize",
						workers: [{ task: "inspect" }],
						synthesizer: { task: "summarize" },
					},
					returnToMain: false,
				},
				undefined,
				undefined,
				ctx,
			);
			const waited = await tool.execute(
				`call-failed-wait-${call}`,
				{ action: "wait", eventId: start.details?.id as string },
				undefined,
				undefined,
				ctx,
			);
			expect(textOf(waited)).toContain("Status: failed");
			expect(textOf(waited)).toContain(expectedError);
		}
	});

	it("resolves the current workflow provider at start so a package selection wins", async () => {
		const result = {
			pattern: "fan_out_synthesize" as const,
			workers: [],
			terminatedBy: "completed" as const,
		};
		const defaultOrchestrate = vi.fn(async () => result);
		const packageOrchestrate = vi.fn(async () => result);
		const defaultProvider: SubAgentWorkflowProvider = { orchestrate: defaultOrchestrate };
		const packageProvider: SubAgentWorkflowProvider = { orchestrate: packageOrchestrate };
		let selectedProvider = defaultProvider;

		controller.shutdown();
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			getWorkflowProvider: () => selectedProvider,
		});
		selectedProvider = packageProvider;

		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const start = await tool.execute(
			"call-package-wf",
			{
				action: "start",
				packages: [" shared-workflow-package "],
				workflow: {
					pattern: "fan_out_synthesize",
					workers: [{ task: "inspect", packages: ["worker-workflow-package"] }],
					synthesizer: { task: "summarize" },
				},
			},
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"call-package-wait",
			{ action: "wait", eventId: start.details?.id as string },
			undefined,
			undefined,
			ctx,
		);

		expect(defaultOrchestrate).not.toHaveBeenCalled();
		expect(packageOrchestrate).toHaveBeenCalledOnce();
		expect(packageOrchestrate).toHaveBeenCalledWith(
			expect.objectContaining({
				pattern: "fan_out_synthesize",
				cwd: tempDir,
				packages: ["shared-workflow-package"],
				workers: [expect.objectContaining({ packages: ["worker-workflow-package"] })],
			}),
			expect.any(AbortSignal),
		);
	});

	it("rejects workflows when the session HCP exposes no multiagent provider", async () => {
		const tool = controller.createToolDefinition();
		await expect(
			tool.execute(
				"call-missing-wf",
				{
					action: "start",
					workflow: {
						pattern: "fan_out_synthesize",
						workers: [{ task: "inspect" }],
						synthesizer: { task: "summarize" },
					},
				},
				undefined,
				undefined,
				createContext(tempDir),
			),
		).rejects.toThrow("unavailable from the session HCP");
	});

	it("surfaces aggregated token/cost usage in the workflow result tree", async () => {
		// Fake runner whose workers report usage, so the orchestrator aggregates it
		// onto OrchestrationResult.usage and the result tree renders a usage line.
		const usageOf = (input: number, output: number, cost: number) => ({
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		});
		const fakeRunner = {
			spawn: async (options: { workerId: string }) => ({
				workerId: options.workerId,
				text: `synth of ${options.workerId}`,
				durationMs: 1,
				success: true,
				usage: usageOf(1000, 200, 0.05),
			}),
			parallel: async (specs: Array<{ workerId: string }>) =>
				specs.map((s) => ({
					workerId: s.workerId,
					text: `did ${s.workerId}`,
					durationMs: 1,
					success: true,
					usage: usageOf(2000, 400, 0.1),
				})),
		};
		controller = new SubAgentController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(spawnRecords, { output: "unused" }),
			getWorkflowProvider: () => new MultiAgentOrchestrator({ cwd: tempDir, runner: fakeRunner as never }),
		});
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-wf",
			{
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					name: "triage",
					workers: [{ task: "look at A" }, { task: "look at B" }],
					synthesizer: { task: "merge findings" },
				},
			},
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		await tool.execute("call-wait", { action: "wait", eventId }, undefined, undefined, ctx);

		const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
		const text = textOf(status);
		// Two parallel workers (2000+400 tokens each) + synthesizer (1000+200):
		// the usage line shows summed input/output arrows and a total cost.
		expect(text).toContain("usage:");
		expect(text).toMatch(/usage:.*↑/);
		expect(text).toMatch(/usage:.*\$/);
	});

	it("bounds the events map by evicting the oldest finished agents", async () => {
		const records: SpawnRecord[] = [];
		const bounded = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(records, { output: "bounded-result" }),
			maxRetainedFinishedEvents: 2,
		});
		try {
			const tool = bounded.createToolDefinition();
			const ctx = createContext(tempDir);

			const ids: string[] = [];
			for (let i = 0; i < 6; i++) {
				const start = await tool.execute(
					`call-start-${i}`,
					{ action: "start", task: `task ${i}`, returnToMain: false },
					undefined,
					undefined,
					ctx,
				);
				const id = start.details?.id as string;
				ids.push(id);
				await tool.execute(`call-wait-${i}`, { action: "wait", eventId: id }, undefined, undefined, ctx);
			}

			// The map stays bounded near the retention cap (prune runs on each start,
			// so the final finished event may linger until the next start).
			const status = await tool.execute("call-status-all", { action: "status" }, undefined, undefined, ctx);
			expect((status.details?.ids as string[]).length).toBeLessThanOrEqual(3);

			// The most recent finished agent is still queryable and evicted ones are gone.
			const recent = await tool.execute(
				"call-status-recent",
				{ action: "status", eventId: ids[ids.length - 1] },
				undefined,
				undefined,
				ctx,
			);
			expect(textOf(recent)).not.toContain("Unknown sub-agent");

			const oldest = await tool.execute(
				"call-status-oldest",
				{ action: "status", eventId: ids[0] },
				undefined,
				undefined,
				ctx,
			);
			expect(textOf(oldest)).toContain(`Unknown sub-agent: ${ids[0]}`);
		} finally {
			bounded.shutdown();
		}
	});

	it("releases the child process reference once an agent finishes", async () => {
		const records: SpawnRecord[] = [];
		const bounded = new SubAgentController(manager, {
			registerReturn: () => {},
			cancelReturn: () => {},
			spawnAgent: createFakeSpawn(records, { output: "done" }),
		});
		try {
			const tool = bounded.createToolDefinition();
			const ctx = createContext(tempDir);
			const start = await tool.execute(
				"call-start",
				{ action: "start", task: "finish quickly", returnToMain: false },
				undefined,
				undefined,
				ctx,
			);
			const eventId = start.details?.id as string;
			await tool.execute("call-wait", { action: "wait", eventId }, undefined, undefined, ctx);

			// After the agent exits, finishEvent() must have dropped the child handle so
			// a retained finished event no longer pins the ChildProcess object.
			const internalEvents = (bounded as unknown as { events: Map<string, { child?: unknown }> }).events;
			expect(internalEvents.get(eventId)?.child).toBeUndefined();
		} finally {
			bounded.shutdown();
		}
	});
});

describe("buildOrchestrationRequest slot remapping", () => {
	it("remaps adversarial_verify threshold -> confidenceThreshold", () => {
		const req = buildOrchestrationRequest({
			pattern: "adversarial_verify",
			verifyCount: 5,
			threshold: 0.6,
		} as never) as unknown as Record<string, unknown>;
		expect(req.confidenceThreshold).toBe(0.6);
		expect(req.verifyCount).toBe(5);
		expect(req.threshold).toBeUndefined();
	});

	it("remaps generate_and_filter candidateCount -> count and topK -> keepTop", () => {
		const req = buildOrchestrationRequest({
			pattern: "generate_and_filter",
			candidateCount: 7,
			topK: 3,
		} as never) as unknown as Record<string, unknown>;
		expect(req.count).toBe(7);
		expect(req.keepTop).toBe(3);
		expect(req.candidateCount).toBeUndefined();
		expect(req.topK).toBeUndefined();
	});

	it("drops the tool-only `name` field and leaves aligned slots untouched", () => {
		const req = buildOrchestrationRequest({
			pattern: "fan_out_synthesize",
			name: "my run",
			maxConcurrent: 4,
			workers: [{ task: "a" }],
		} as never) as unknown as Record<string, unknown>;
		expect(req.name).toBeUndefined();
		expect(req.maxConcurrent).toBe(4);
		expect(req.workers).toEqual([{ task: "a" }]);
	});

	it("omits remapped keys entirely when they are not supplied", () => {
		const req = buildOrchestrationRequest({
			pattern: "adversarial_verify",
		} as never) as unknown as Record<string, unknown>;
		expect("confidenceThreshold" in req).toBe(false);
		expect("count" in req).toBe(false);
		expect("keepTop" in req).toBe(false);
	});

	it("rejects programmatically constructed inline script workflows", () => {
		expect(() =>
			buildOrchestrationRequest({
				pattern: "script",
				script: "export default async () => ({ ok: true });",
				args: { x: 21 },
			} as never),
		).toThrow(/not accepted by the sub_agent tool/);
		expect(() => buildOrchestrationRequest({ pattern: "script" } as never)).toThrow(
			/not accepted by the sub_agent tool/,
		);
	});

	it("never leaks script-only fields into a preset request", () => {
		const req = buildOrchestrationRequest({
			pattern: "fan_out_synthesize",
			workers: [{ task: "a" }],
			// stray fields that only belong to `script` must be dropped
			script: "export default async () => {};",
			args: { x: 1 },
		} as never) as unknown as Record<string, unknown>;
		expect("script" in req).toBe(false);
		expect("args" in req).toBe(false);
		expect(req.workers).toEqual([{ task: "a" }]);
	});
});
