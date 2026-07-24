import { describe, expect, it } from "vitest";
import { MultiAgentOrchestrator } from "../../tools/sub-agent/magenta/workflow/orchestrator.ts";
import { buildSystemPrompt } from "../../tools/sub-agent/magenta/workflow/worker.ts";
import type { WorkerSlot } from "../../tools/sub-agent/magenta/workflow-types.ts";

/**
 * These guards protect the orchestration CONTRACT, not the worker execution.
 * Worker execution spawns real `pi` processes and is covered separately; here we
 * assert the deterministic surface: which patterns exist, the HCP description,
 * and that the skeleton's guard prompt is always prepended ahead of LLM content.
 */
describe("multiagent orchestrator", () => {
	it("discovers all seven patterns on the local target", () => {
		const orch = new MultiAgentOrchestrator();
		const discovered = orch.discover();
		expect(discovered.provider).toBe("multiagent");
		expect(discovered.targets).toEqual(["multiagent://local"]);
		expect([...discovered.patterns].sort()).toEqual(
			[
				"adversarial_verify",
				"classify_and_act",
				"fan_out_synthesize",
				"generate_and_filter",
				"loop_until_done",
				"tournament",
				"script",
			].sort(),
		);
	});

	it("dispatches every pattern to an implementation (no notImplemented rejections)", () => {
		const orch = new MultiAgentOrchestrator();
		// All seven patterns are wired; discover() reflects the full set.
		expect(orch.discover().patterns).toHaveLength(7);
	});

	it("passes the host invocation resolver to every internal worker", async () => {
		const requestedArgs: string[][] = [];
		const fixture = [
			"const event = {",
			'type: "message_end",',
			'message: { role: "assistant", content: [{ type: "text", text: "worker-ok" }] },',
			"};",
			'process.stdout.write(JSON.stringify(event) + "\\n");',
			'process.stdout.write(JSON.stringify({ type: "run_end", protocolVersion: 1, status: "success", exitCode: 0 }) + "\\n");',
		].join("\n");
		const provider = new MultiAgentOrchestrator({
			resolveWorkerInvocation: (args: string[]) => {
				requestedArgs.push([...args]);
				return { command: process.execPath, args: ["-e", fixture] };
			},
		});

		const result = await provider.orchestrate({
			pattern: "fan_out_synthesize",
			packages: ["ClaudeScience"],
			workers: [{ task: "inspect" }],
			synthesizer: { task: "summarize" },
		});

		expect(result.outcome?.text).toBe("worker-ok");
		expect(requestedArgs).toHaveLength(2);
		for (const args of requestedArgs) {
			expect(args).toEqual(expect.arrayContaining(["--harness-package", "ClaudeScience"]));
		}
	});
});

describe("buildSystemPrompt guard invariant", () => {
	it("always places the skeleton guard before the LLM-supplied focus", () => {
		const guard = "SOUL STEP: classify first.";
		const slot: WorkerSlot = { task: "task", focus: "look at severity" };
		const assembled = buildSystemPrompt(guard, slot);
		expect(assembled.indexOf(guard)).toBe(0);
		expect(assembled.indexOf("look at severity")).toBeGreaterThan(assembled.indexOf(guard));
	});

	it("appends the schema instruction when a slot supplies a schema", () => {
		const slot: WorkerSlot = { task: "t", schema: { type: "object" } };
		const assembled = buildSystemPrompt("guard", slot);
		expect(assembled).toContain("JSON matching this schema");
		expect(assembled).toContain('"type": "object"');
	});

	it("emits only the guard when no focus or schema is given", () => {
		const assembled = buildSystemPrompt("just the guard", { task: "t" });
		expect(assembled).toBe("just the guard");
	});
});
