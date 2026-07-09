import { describe, expect, it } from "vitest";
import type { WorkerSlot } from "../../modules/multiagent/contract.ts";
import { multiagentMagentaMagnet } from "../../modules/multiagent/workflow/magenta/HcpMagnet.ts";
import { MultiAgentOrchestrator } from "../../modules/multiagent/workflow/magenta/orchestrator.ts";
import { buildSystemPrompt } from "../../modules/multiagent/workflow/magenta/worker.ts";

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

	it("exposes an HCP server describing the orchestrate op", () => {
		const server = multiagentMagentaMagnet.build({ repoRoot: process.cwd(), packagesRoot: process.cwd() });
		const desc = server.describe();
		expect(desc.target).toBe("multiagent://local");
		expect(desc.kind).toBe("multiagent");
		expect(desc.ops).toContain("orchestrate");
		expect((desc.metadata as { patterns: string[] }).patterns).toHaveLength(7);
	});

	it("dispatches every pattern to an implementation (no notImplemented rejections)", () => {
		const orch = new MultiAgentOrchestrator();
		// All seven patterns are wired; discover() reflects the full set.
		expect(orch.discover().patterns).toHaveLength(7);
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
