import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiAgentOrchestrator } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_BINARY_NAME } from "../src/config.ts";
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

		expect(eventId).toMatch(/^agent_/);
		expect(spawnRecords[0]?.command).toBe(APP_BINARY_NAME);
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

		// Because the model synchronously waited for (and was shown) the result,
		// the pending returnToMain auto-delivery must be cancelled: no duplicate
		// "[sub-agent-return]" message and no extra triggered turn.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(returned).toHaveLength(0);
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

	it("caps the complete aggregate return including huge tasks and instructions", async () => {
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
		await waitUntil(() => returned.length === 1);

		const returnedMessage = returned[0]?.message;
		expect(Buffer.byteLength(returnedMessage?.content ?? "", "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(returnedMessage?.content).toContain("Model-visible result shortened");
		const details = returnedMessage?.details as
			| { instruction?: string; eventData?: SubAgentEventSnapshot[] }
			| undefined;
		expect(Buffer.byteLength(details?.instruction ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
		expect(details?.eventData).toHaveLength(8);
		expect(details?.eventData?.every((event) => event.tail.includes("AGGREGATE-TAIL"))).toBe(true);
	});

	it("inherits the parent model when a task has no explicit model", async () => {
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

		expect(spawnRecords[0]?.command).toBe(APP_BINARY_NAME);
		expect(spawnRecords[0]?.args).toEqual(
			expect.arrayContaining(["--provider", "anthropic", "--model", "claude-opus-4-8"]),
		);
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
		expect(start.details?.ids).toHaveLength(2);
		expect(spawnRecords).toHaveLength(2);
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

	it("encodes an inline `script` workflow as a data: URL scriptPath", async () => {
		const source = "export default async (args, ctx) => ({ got: args.x * 2 });";
		const req = buildOrchestrationRequest({
			pattern: "script",
			name: "my custom",
			script: source,
			args: { x: 21 },
			model: "some-model",
			maxConcurrent: 3,
		} as never) as unknown as Record<string, unknown>;

		expect(req.pattern).toBe("script");
		expect(typeof req.scriptPath).toBe("string");
		expect(req.scriptPath as string).toMatch(/^data:text\/javascript;base64,/);
		// Tool-only `name` and raw `script` never reach the contract.
		expect("name" in req).toBe(false);
		expect("script" in req).toBe(false);
		// CommonOptions + args pass through untouched.
		expect(req.args).toEqual({ x: 21 });
		expect(req.model).toBe("some-model");
		expect(req.maxConcurrent).toBe(3);

		// The encoded module is the exact source and dynamically importable.
		const mod = (await import(req.scriptPath as string)) as {
			default: (args: unknown, ctx: unknown) => Promise<{ got: number }>;
		};
		const result = await mod.default({ x: 21 }, {});
		expect(result).toEqual({ got: 42 });
	});

	it("rejects a `script` workflow with empty or missing source", () => {
		expect(() => buildOrchestrationRequest({ pattern: "script" } as never)).toThrow(/requires a non-empty/);
		expect(() => buildOrchestrationRequest({ pattern: "script", script: "   " } as never)).toThrow(
			/requires a non-empty/,
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
