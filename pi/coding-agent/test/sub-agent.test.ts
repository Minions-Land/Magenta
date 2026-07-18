import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundEventManager } from "../src/core/background-events.ts";
import { buildOrchestrationRequest, SubAgentController, sanitizeSubAgentTools } from "../src/core/tools/sub-agent.ts";

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("Pi sub_agent HCP adapter", () => {
	let root: string | undefined;
	let manager: BackgroundEventManager | undefined;
	let controller: SubAgentController | undefined;

	afterEach(() => {
		controller?.shutdown();
		manager?.dispose();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
		manager = undefined;
		controller = undefined;
	});

	it("re-exports the strict singular HCP Tool contract", () => {
		root = mkdtempSync(join(tmpdir(), "pi-hcp-sub-agent-"));
		manager = new BackgroundEventManager();
		controller = new SubAgentController(manager, {
			cwd: root,
			workDirRoot: join(root, "events"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			registerReturn: () => {},
			cancelReturn: () => {},
		});
		const tool = controller.createToolDefinition();
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(properties.tasks).toBeUndefined();
		expect(properties.eventIds).toBeUndefined();
		expect(properties.returnDelivery).toBeUndefined();
		expect(properties.defaultThinking).toBeUndefined();
		for (const arguments_ of [
			{ action: "wait", eventId: "agent_001" },
			{ action: "config" },
			{ action: "start", tasks: [{ task: "one" }] },
			{ action: "status", eventIds: ["agent_001"] },
		]) {
			const call: ToolCall = { type: "toolCall", id: "invalid", name: "sub_agent", arguments: arguments_ };
			expect(() => validateToolArguments(tool as unknown as Tool, call)).toThrow("Validation failed");
		}
	});

	it("accepts queued registration through Pi BackgroundEventManager", async () => {
		root = mkdtempSync(join(tmpdir(), "pi-hcp-sub-agent-"));
		manager = new BackgroundEventManager();
		const spawns: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
			const child = new EventEmitter() as ChildProcess & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				kill: ReturnType<typeof vi.fn>;
			};
			Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 999999 });
			child.kill = vi.fn(() => true);
			spawns.push({ command, args, options });
			setTimeout(() => child.emit("close", 0, null), 5);
			return child;
		};
		controller = new SubAgentController(manager, {
			cwd: root,
			workDirRoot: join(root, "events"),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			spawnAgent: spawn,
			registerReturn: (_ids, _message, _delivery, receipt) => receipt.onPersisted(),
			cancelReturn: () => {},
		});
		const result = await controller.createToolDefinition().execute("start", {
			action: "start",
			task: "inspect",
		});
		expect(result.details).toMatchObject({
			schemaVersion: 1,
			action: "start",
			eventId: "agent_001",
			state: "queued",
		});
		await waitUntil(() => spawns.length === 1);
		expect(spawns[0]).toMatchObject({ command: "/magenta", options: { cwd: root } });
	});

	it("strips recursive delegation tools and preserves other grants", () => {
		expect(sanitizeSubAgentTools(["read", "sub_agent", "bg_shell", "multiagent", "bash"])).toEqual(["read", "bash"]);
		expect(sanitizeSubAgentTools(["sub_agent", "bg_shell", "multiagent"])).toEqual(["read", "grep", "find", "ls"]);
	});
});

describe("sub_agent Workflow request mapping", () => {
	it("remaps adversarial_verify threshold", () => {
		const request = buildOrchestrationRequest({
			pattern: "adversarial_verify",
			generator: { task: "draft" },
			verifier: { task: "verify" },
			threshold: 0.9,
		});
		expect(request).toMatchObject({ pattern: "adversarial_verify", confidenceThreshold: 0.9 });
		expect(request).not.toHaveProperty("threshold");
	});

	it("remaps generate_and_filter candidate count and top-k", () => {
		const request = buildOrchestrationRequest({
			pattern: "generate_and_filter",
			generator: { task: "generate" },
			evaluator: { task: "score" },
			candidateCount: 5,
			topK: 2,
		});
		expect(request).toMatchObject({ pattern: "generate_and_filter", count: 5, keepTop: 2 });
		expect(request).not.toHaveProperty("candidateCount");
		expect(request).not.toHaveProperty("topK");
	});

	it("drops facade-only name while retaining aligned worker slots", () => {
		const request = buildOrchestrationRequest({
			pattern: "fan_out_synthesize",
			name: "review",
			workers: [{ task: "inspect", focus: "correctness" }],
			synthesizer: { task: "synthesize" },
		});
		expect(request).not.toHaveProperty("name");
		expect(request).toMatchObject({ workers: [{ task: "inspect", focus: "correctness" }] });
	});

	it("rejects the trusted-only script pattern even when schema validation is bypassed", () => {
		expect(() => buildOrchestrationRequest({ pattern: "script" } as never)).toThrow(
			'workflow pattern "script" is not accepted',
		);
	});
});
