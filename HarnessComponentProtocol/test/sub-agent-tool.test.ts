import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_MAX_TIMEOUT_SECONDS } from "../_magenta/timeout.ts";
import {
	type BackgroundEventManagerPort,
	MAIN_PROGRESS_WRITE_INTERVAL_MS,
	SubAgentController,
	type SubAgentReturnMessage,
	type SubAgentSpawn,
	subAgentSchema,
} from "../tools/sub-agent/magenta/sub-agent.ts";

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	while (!(await predicate())) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type SpawnRecord = {
	command: string;
	args: string[];
	options: SpawnOptions;
	child: ChildProcess & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
};

function fakeSpawn(records: SpawnRecord[], autoClose = false, output = "finite result"): SubAgentSpawn {
	return (command, args, options) => {
		const child = new EventEmitter() as SpawnRecord["child"];
		Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 999999 });
		child.kill = vi.fn(() => true);
		records.push({ command, args, options, child });
		if (autoClose) {
			setTimeout(() => {
				child.stdout.emit("data", Buffer.from(output));
				child.emit("close", 0, null);
			}, 5);
		}
		return child;
	};
}

function eventStates(result: { details?: unknown }): Array<{ eventId: string; state: string; queuePosition?: number }> {
	return (result.details as { events: Array<{ eventId: string; state: string; queuePosition?: number }> }).events;
}

describe("HCP sub_agent Tool Source", () => {
	let root: string;
	let records: SpawnRecord[];
	let returns: SubAgentReturnMessage[];
	let controller: SubAgentController;
	let source: Parameters<BackgroundEventManagerPort["registerSource"]>[0] | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hcp-sub-agent-"));
		records = [];
		returns = [];
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args: ["agent", ...args] }),
			spawnAgent: fakeSpawn(records),
			registerReturn: (_eventIds, message, delivery, receipt) => {
				returns.push({ message, options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" } });
				receipt.onPersisted();
			},
			cancelReturn: () => {},
		});
	});

	afterEach(() => {
		controller.shutdown();
		rmSync(root, { recursive: true, force: true });
	});

	it("publishes only singular start/status/cancel input", () => {
		const tool = controller.createToolDefinition();
		const properties = (tool.parameters as { properties: Record<string, unknown>; additionalProperties: boolean })
			.properties;
		expect(Object.keys(properties).sort()).toEqual(
			[
				"action",
				"cwd",
				"eventId",
				"label",
				"model",
				"packages",
				"provider",
				"role",
				"task",
				"thinking",
				"timeoutSeconds",
				"tools",
				"workflow",
			].sort(),
		);
		expect((tool.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
		for (const arguments_ of [
			{ action: "wait", eventId: "agent_001" },
			{ action: "config" },
			{ action: "start", tasks: [{ task: "a" }] },
			{ action: "status", eventIds: ["agent_001"] },
			{ action: "start", task: "a", returnDelivery: "steer" },
		]) {
			const call: ToolCall = { type: "toolCall", id: "invalid", name: "sub_agent", arguments: arguments_ };
			expect(() => validateToolArguments(tool as unknown as Tool, call)).toThrow("Validation failed");
		}
	});

	it("coalesces rapid parent progress and flushes the latest snapshot at boundaries", async () => {
		controller.shutdown();
		const writes: string[] = [];
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource() {
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "progress-events"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			spawnAgent: fakeSpawn(records),
			registerReturn: () => {},
			cancelReturn: () => {},
			progressWriteIntervalMs: 30,
			progressWriter: (_path, content) => writes.push(content),
		});
		expect(MAIN_PROGRESS_WRITE_INTERVAL_MS).toBe(1_000);

		controller.handleAgentEvent({ type: "agent_start" } as any);
		controller.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "noisy" },
		} as any);
		for (let index = 0; index < 25; index++) {
			controller.handleAgentEvent({
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "noisy" },
				partialResult: `progress-${index}`,
			} as any);
		}
		expect(writes).toHaveLength(2);
		await waitUntil(() => writes.length === 3);
		expect(writes[2]).toContain("progress-24");

		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: "terminal-result",
			isError: false,
		} as any);
		expect(writes.at(-1)).toContain("terminal-result");
		controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "tool-2",
			toolName: "bash",
			args: {},
			partialResult: "shutdown-latest",
		} as any);
		const beforeShutdown = writes.length;
		controller.shutdown();
		expect(writes).toHaveLength(beforeShutdown + 1);
		expect(writes.at(-1)).toContain("shutdown-latest");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(writes).toHaveLength(beforeShutdown + 1);
	});

	it("writes the parent progress file atomically with private permissions", () => {
		controller.handleAgentEvent({ type: "agent_start" } as any);
		const eventRoot = join(root, "events");
		const controllerDirectory = readdirSync(eventRoot).find((entry) => entry.includes("-"));
		if (!controllerDirectory) throw new Error("Missing sub-agent controller directory");
		const progressPath = join(eventRoot, controllerDirectory, "main-tool-progress.md");
		expect(readFileSync(progressPath, "utf8")).toContain("Parent main-agent tool progress");
		expect(statSync(progressPath).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(eventRoot, controllerDirectory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
	});

	it("publishes the same bounded timeout domain for outer Events and workflow slots", () => {
		const outer = (subAgentSchema as { properties: Record<string, any> }).properties.timeoutSeconds;
		const workflow = (subAgentSchema as { properties: Record<string, any> }).properties.workflow;
		const slot = workflow.properties.workers.items.properties.timeoutSeconds;
		expect(outer.description).toContain("Omit for no caller deadline");
		expect(slot.description).toContain("Omit for no worker deadline");

		for (const timeoutSeconds of [0.001, NODE_MAX_TIMEOUT_SECONDS]) {
			expect(Check(subAgentSchema, { action: "start", task: "long task", timeoutSeconds })).toBe(true);
			expect(
				Check(subAgentSchema, {
					action: "start",
					workflow: {
						pattern: "fan_out_synthesize",
						workers: [{ task: "analyze", timeoutSeconds }],
						synthesizer: { task: "merge" },
					},
				}),
			).toBe(true);
		}

		for (const timeoutSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, NODE_MAX_TIMEOUT_SECONDS + 0.001]) {
			expect(Check(subAgentSchema, { action: "start", task: "bad timeout", timeoutSeconds })).toBe(false);
			expect(
				Check(subAgentSchema, {
					action: "start",
					workflow: {
						pattern: "fan_out_synthesize",
						workers: [{ task: "analyze", timeoutSeconds }],
						synthesizer: { task: "merge" },
					},
				}),
			).toBe(false);
		}
	});

	it("rejects invalid outer and workflow-slot timeouts even when schema validation is bypassed", async () => {
		const tool = controller.createToolDefinition();
		const overflow = NODE_MAX_TIMEOUT_SECONDS + 0.001;
		await expect(
			tool.execute("outer-overflow", { action: "start", task: "bad timeout", timeoutSeconds: overflow }),
		).rejects.toThrow(/timeoutSeconds.*maximum/);
		await expect(
			tool.execute("slot-overflow", {
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					workers: [{ task: "analyze", timeoutSeconds: overflow }],
					synthesizer: { task: "merge" },
				},
			}),
		).rejects.toThrow(/workflow\.workers\[0\]\.timeoutSeconds.*maximum/);
		expect(records).toHaveLength(0);
		expect(source?.getEvents()).toHaveLength(0);
	});

	it("leaves an omitted Event timeout without a hard deadline", async () => {
		const tool = controller.createToolDefinition();
		const start = await tool.execute("no-deadline", { action: "start", task: "long task" });
		const eventId = (start.details as { eventId: string }).eventId;
		await waitUntil(() => records.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(eventStates(await awaitStatus(tool, eventId))[0]?.state).toBe("running");
	});

	it("registers one queued Event and launches it asynchronously", async () => {
		const tool = controller.createToolDefinition();
		const result = await tool.execute("start", { action: "start", task: "inspect", tools: ["read", "sub_agent"] });
		expect(result.details).toMatchObject({
			schemaVersion: 1,
			action: "start",
			eventId: "agent_001",
			state: "queued",
			capacity: { limit: 8 },
		});
		await waitUntil(() => records.length === 1);
		expect(records[0]).toMatchObject({ command: "/magenta", options: { cwd: root } });
		expect(records[0]!.args).toEqual(
			expect.arrayContaining(["agent", "--print", "--no-session", "--no-extensions", "--tools", "read"]),
		);
		if (process.platform !== "win32") {
			const promptArgument = records[0]!.args.find((argument) => argument.startsWith("@"));
			if (!promptArgument) throw new Error("Missing sub-agent prompt argument");
			const promptPath = promptArgument.slice(1);
			const logPath = source?.getEvents()[0]?.logPath;
			if (!logPath) throw new Error("Missing sub-agent log path");
			expect(statSync(promptPath).mode & 0o777).toBe(0o600);
			expect(statSync(logPath).mode & 0o777).toBe(0o600);
			expect(statSync(join(promptPath, "..")).mode & 0o777).toBe(0o700);
		}
	});

	it("cleans old known artifacts and empty dead-process directories before each start", async () => {
		controller.shutdown();
		const workDirRoot = join(root, "retention-events");
		const removable = join(workDirRoot, "2147483646-deadbeef");
		const withUnknown = join(workDirRoot, "2147483645-feedface");
		const knownNames = ["agent_001-old.log", "agent_001-old.prompt.md", "main-tool-progress.md"];
		for (const directory of [removable, withUnknown]) {
			mkdirSync(directory, { recursive: true });
			for (const name of knownNames) {
				const artifact = join(directory, name);
				writeFileSync(artifact, "old");
				utimesSync(artifact, new Date(0), new Date(0));
			}
		}
		const unknown = join(withUnknown, "keep.bin");
		writeFileSync(unknown, "keep");
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot,
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			spawnAgent: fakeSpawn(records),
			registerReturn: () => {},
			cancelReturn: () => {},
		});

		await controller.createToolDefinition().execute("cleanup-start", { action: "start", task: "inspect" });
		await waitUntil(() => records.length === 1);

		expect(existsSync(removable)).toBe(false);
		for (const name of knownNames) expect(existsSync(join(withUnknown, name))).toBe(false);
		expect(existsSync(unknown)).toBe(true);
	});

	it("admits at most eight active Events and starts the ninth FIFO", async () => {
		const tool = controller.createToolDefinition();
		const ids: string[] = [];
		for (let index = 0; index < 9; index++) {
			const result = await tool.execute(`start-${index}`, { action: "start", task: `task ${index}` });
			ids.push((result.details as { eventId: string }).eventId);
		}
		await waitUntil(() => records.length === 8);
		const queued = await tool.execute("status-9", { action: "status", eventId: ids[8] });
		expect(eventStates(queued)[0]).toMatchObject({ eventId: ids[8], state: "queued", queuePosition: 1 });
		records[0]!.child.emit("close", 0, null);
		await waitUntil(() => records.length === 9);
		const ninth = await tool.execute("status-9-running", { action: "status", eventId: ids[8] });
		expect(eventStates(ninth)[0]!.state).toBe("running");
	});

	it("cancels a queued Event without spawning it", async () => {
		const tool = controller.createToolDefinition();
		for (let index = 0; index < 8; index++)
			await tool.execute(`fill-${index}`, { action: "start", task: `fill ${index}` });
		const ninth = await tool.execute("queued", { action: "start", task: "queued" });
		const eventId = (ninth.details as { eventId: string }).eventId;
		await waitUntil(() => records.length === 8);
		const cancelled = await tool.execute("cancel", { action: "cancel", eventId });
		expect(cancelled.details).toEqual({ schemaVersion: 1, action: "cancel", eventId, state: "cancelled" });
		records[0]!.child.emit("close", 0, null);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(records).toHaveLength(8);
	});

	it("starts explicit timeout at registration and can time out while queued", async () => {
		const tool = controller.createToolDefinition();
		for (let index = 0; index < 8; index++)
			await tool.execute(`fill-${index}`, { action: "start", task: `fill ${index}` });
		const ninth = await tool.execute("queued-timeout", { action: "start", task: "queued", timeoutSeconds: 0.02 });
		const eventId = (ninth.details as { eventId: string }).eventId;
		await waitUntil(async () => eventStates(await awaitStatus(tool, eventId))[0]?.state === "timed_out");
		expect(records).toHaveLength(8);
	});

	it("captures output, settles once, and emits one terminal activation", async () => {
		controller.shutdown();
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events-2"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			spawnAgent: fakeSpawn(records, true, "terminal output"),
			registerReturn: (_ids, message, delivery, receipt) => {
				returns.push({ message, options: { deliverAs: delivery } });
				receipt.onPersisted();
			},
			cancelReturn: () => {},
		});
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start", task: "finish" });
		await waitUntil(() => returns.length === 1);
		expect(returns[0]!.message.content).toContain("terminal output");
		expect((returns[0]!.message.details as { statuses: string[] }).statuses).toEqual(["exited"]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(returns).toHaveLength(1);
	});

	it("retains only the configured number of delivered terminal receipts", async () => {
		controller.shutdown();
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events-3"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			spawnAgent: fakeSpawn(records, true),
			registerReturn: (_ids, message, _delivery, receipt) => {
				returns.push({ message, options: {} });
				receipt.onPersisted();
			},
			cancelReturn: () => {},
			maxRetainedFinishedEvents: 2,
		});
		const tool = controller.createToolDefinition();
		for (let index = 0; index < 3; index++)
			await tool.execute(`start-${index}`, { action: "start", task: `task ${index}` });
		await waitUntil(() => returns.length === 3);
		const status = await tool.execute("status", { action: "status" });
		expect(eventStates(status)).toHaveLength(2);
		expect(eventStates(status).map((event) => event.eventId)).toEqual(["agent_003", "agent_002"]);
	});

	it("preserves independent UTF-8 decoder state across stdout and stderr", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("start", { action: "start", task: "unicode" });
		await waitUntil(() => records.length === 1);
		const child = records[0]!.child;
		const stdout = Buffer.from("prefix🙂中文suffix");
		const stderr = Buffer.from("stderr|");
		child.stderr.emit("data", stderr);
		child.stdout.emit("data", stdout.subarray(0, 8));
		child.stdout.emit("data", stdout.subarray(8, 11));
		child.stdout.emit("data", stdout.subarray(11));
		expect(source?.getEvents()[0]?.tail).toBe("stderr|prefix🙂中文suffix");
		child.emit("close", 0, null);
		await waitUntil(() => returns.length === 1);
		const snapshot = (returns[0]!.message.details as { eventData: Array<{ tail: string }> }).eventData[0]!;
		expect(snapshot.tail).toBe("stderr|prefix🙂中文suffix");
		expect(snapshot.tail).not.toContain("�");
		const logPath = source?.getEvents()[0]?.logPath;
		if (!logPath) throw new Error("Missing sub-agent log path");
		await waitUntil(() => readFileSync(logPath, "utf8").includes("stderr|prefix🙂中文suffix"));
	});

	it("passes inherited model, packages, thinking, and sanitized tools to the child", async () => {
		controller.shutdown();
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events-flags"),
			resolveAgentInvocation: (args) => ({ command: "/node", args: ["/magenta/dist/cli.js", ...args] }),
			spawnAgent: fakeSpawn(records),
			registerReturn: () => {},
			cancelReturn: () => {},
			getDefaultModel: () => ({ provider: "openai", model: "gpt-parent" }),
		});
		const tool = controller.createToolDefinition();
		await tool.execute("start", {
			action: "start",
			task: "flags",
			model: "default",
			thinking: "high",
			tools: ["read", "sub_agent", "bash"],
			packages: ["alpha", " beta "],
		});
		await waitUntil(() => records.length === 1);
		expect(records[0]!.command).toBe("/node");
		expect(records[0]!.args).toEqual(
			expect.arrayContaining([
				"/magenta/dist/cli.js",
				"--no-session",
				"--no-extensions",
				"--tools",
				"read,bash",
				"--thinking",
				"high",
				"--harness-package",
				"alpha",
				"--harness-package",
				"beta",
				"--provider",
				"openai",
				"--model",
				"gpt-parent",
			]),
		);
	});

	it("keeps a running cancellation nonterminal until the child closes", async () => {
		const tool = controller.createToolDefinition();
		const start = await tool.execute("start", { action: "start", task: "cancel me" });
		const eventId = (start.details as { eventId: string }).eventId;
		await waitUntil(() => records.length === 1);
		records[0]!.child.stdout.emit("data", Buffer.from("cancelled tail"));
		const logPath = source?.getEvents()[0]?.logPath;
		if (!logPath) throw new Error("Missing sub-agent log path");
		const cancel = await tool.execute("cancel", { action: "cancel", eventId });
		expect((cancel.details as { state: string }).state).toBe("terminating");
		expect(records[0]!.child.kill).toHaveBeenCalled();
		expect(returns).toHaveLength(0);
		await waitUntil(() => readFileSync(logPath, "utf8").includes("cancelled tail"));
		records[0]!.child.emit("close", null, "SIGTERM");
		await waitUntil(() => returns.length === 1);
		const status = await awaitStatus(tool, eventId);
		expect(eventStates(status)[0]!.state).toBe("cancelled");
	});

	it("keeps a running timeout nonterminal until process settlement", async () => {
		const tool = controller.createToolDefinition();
		const start = await tool.execute("start", { action: "start", task: "timeout", timeoutSeconds: 0.02 });
		const eventId = (start.details as { eventId: string }).eventId;
		await waitUntil(() => records.length === 1);
		records[0]!.child.stdout.emit("data", Buffer.from("timeout tail"));
		const logPath = source?.getEvents()[0]?.logPath;
		if (!logPath) throw new Error("Missing sub-agent log path");
		await waitUntil(async () => eventStates(await awaitStatus(tool, eventId))[0]?.state === "terminating");
		expect(returns).toHaveLength(0);
		await waitUntil(() => readFileSync(logPath, "utf8").includes("timeout tail"));
		records[0]!.child.emit("close", null, "SIGTERM");
		await waitUntil(() => returns.length === 1);
		expect(eventStates(await awaitStatus(tool, eventId))[0]!.state).toBe("timed_out");
	});

	it("flushes buffered worker output on child error and shutdown", async () => {
		const tool = controller.createToolDefinition();
		await tool.execute("error-start", { action: "start", task: "error path" });
		await waitUntil(() => records.length === 1);
		records[0]!.child.stdout.emit("data", Buffer.from("error tail"));
		const errorLogPath = source?.getEvents()[0]?.logPath;
		if (!errorLogPath) throw new Error("Missing sub-agent error log path");
		records[0]!.child.emit("error", new Error("child failed"));
		await waitUntil(() => returns.length === 1);
		await waitUntil(() => readFileSync(errorLogPath, "utf8").includes("error tail"));

		await tool.execute("shutdown-start", { action: "start", task: "shutdown path" });
		await waitUntil(() => records.length === 2);
		records[1]!.child.stdout.emit("data", Buffer.from("shutdown tail"));
		const shutdownEvent = source?.getEvents().find((event) => event.status === "running");
		const shutdownLogPath = shutdownEvent?.logPath;
		if (!shutdownLogPath) throw new Error("Missing sub-agent shutdown log path");
		controller.shutdown();
		expect(records[1]!.child.kill).toHaveBeenCalled();
		await waitUntil(() => readFileSync(shutdownLogPath, "utf8").includes("shutdown tail"));
		records[1]!.child.emit("close", null, "SIGTERM");
	});

	it("settles post-admission spawn failure as a failed Event", async () => {
		controller.shutdown();
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events-spawn-error"),
			resolveAgentInvocation: (args) => ({ command: "/missing", args }),
			spawnAgent: (() => {
				throw new Error("spawn unavailable");
			}) as SubAgentSpawn,
			registerReturn: (_ids, message, _delivery, receipt) => {
				returns.push({ message, options: {} });
				receipt.onPersisted();
			},
			cancelReturn: () => {},
		});
		const tool = controller.createToolDefinition();
		const start = await tool.execute("start", { action: "start", task: "fail later" });
		expect(start.details).toMatchObject({ state: "queued" });
		await waitUntil(() => returns.length === 1);
		expect(returns[0]!.message.content).toContain("spawn unavailable");
		expect((returns[0]!.message.details as { statuses: string[] }).statuses).toEqual(["failed"]);
	});

	it("keeps an abort-ignoring Workflow active until the provider settles", async () => {
		let resolveWorkflow!: (value: {
			pattern: "fan_out_synthesize";
			workers: [];
			terminatedBy: "completed";
			durationMs: number;
		}) => void;
		const workflow = new Promise<{
			pattern: "fan_out_synthesize";
			workers: [];
			terminatedBy: "completed";
			durationMs: number;
		}>((resolve) => {
			resolveWorkflow = resolve;
		});
		controller.shutdown();
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events-workflow-cancel"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			registerReturn: (_ids, message, _delivery, receipt) => {
				returns.push({ message, options: {} });
				receipt.onPersisted();
			},
			cancelReturn: () => {},
			getWorkflowProvider: () => ({ orchestrate: () => workflow }),
		});
		const tool = controller.createToolDefinition();
		const start = await tool.execute("workflow", {
			action: "start",
			workflow: {
				pattern: "fan_out_synthesize",
				workers: [{ task: "analyze" }],
				synthesizer: { task: "synthesize" },
			},
		});
		const eventId = (start.details as { eventId: string }).eventId;
		await waitUntil(async () => eventStates(await awaitStatus(tool, eventId))[0]?.state === "running");
		await tool.execute("cancel", { action: "cancel", eventId });
		expect(eventStates(await awaitStatus(tool, eventId))[0]!.state).toBe("terminating");
		expect(returns).toHaveLength(0);
		resolveWorkflow({ pattern: "fan_out_synthesize", workers: [], terminatedBy: "completed", durationMs: 1 });
		await waitUntil(() => returns.length === 1);
		expect(eventStates(await awaitStatus(tool, eventId))[0]!.state).toBe("cancelled");
	});

	it("runs a trusted Workflow as one top-level Event", async () => {
		const orchestrate = vi.fn(async () => ({
			pattern: "fan_out_synthesize" as const,
			workers: [],
			terminatedBy: "completed" as const,
			outcome: { workerId: "outcome", text: "workflow result", durationMs: 1, success: true },
			durationMs: 1,
		}));
		controller.shutdown();
		const backgroundEvents: BackgroundEventManagerPort = {
			registerSource(candidate) {
				source = candidate;
				return { update: () => {}, dispose: () => {} };
			},
		};
		controller = new SubAgentController(backgroundEvents, {
			cwd: root,
			workDirRoot: join(root, "events-4"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			registerReturn: (_ids, message, _delivery, receipt) => {
				returns.push({ message, options: {} });
				receipt.onPersisted();
			},
			cancelReturn: () => {},
			getWorkflowProvider: () => ({ orchestrate }),
		});
		const tool = controller.createToolDefinition();
		const result = await tool.execute("workflow", {
			action: "start",
			workflow: {
				pattern: "fan_out_synthesize",
				workers: [{ task: "analyze" }],
				synthesizer: { task: "synthesize" },
			},
		});
		expect(result.details).toMatchObject({ eventId: "agent_001", state: "queued" });
		await waitUntil(() => returns.length === 1);
		expect(orchestrate).toHaveBeenCalledOnce();
		expect(returns[0]!.message.content).toContain("workflow result");
		expect(source?.getEvents()).toHaveLength(1);
	});
});

async function awaitStatus(tool: ReturnType<SubAgentController["createToolDefinition"]>, eventId: string) {
	return tool.execute("status", { action: "status", eventId });
}
