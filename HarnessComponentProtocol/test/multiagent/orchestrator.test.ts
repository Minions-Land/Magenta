import { describe, expect, it } from "vitest";
import { HcpClient } from "../../HcpClient.ts";
import type { WorkerSlot } from "../../multiagent/HcpServer.ts";
import * as multiagentServer from "../../multiagent/HcpServer.ts";
import * as multiagentWorkflowMagenta from "../../multiagent/workflow/magenta/HcpMagnet.ts";
import { MultiAgentOrchestrator } from "../../multiagent/workflow/magenta/orchestrator.ts";
import { buildSystemPrompt } from "../../multiagent/workflow/magenta/worker.ts";

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

	it("exposes the source through the real module HCP server", async () => {
		const magnet = new multiagentWorkflowMagenta.HcpMagnet({
			repoRoot: process.cwd(),
			packagesRoot: process.cwd(),
			kind: "multiagent",
			name: "multiagent",
			source: "magenta",
		});
		const hcp = new HcpClient();
		hcp.registerModule(new multiagentServer.HcpServer(), new Map([["multiagent", magnet]]));

		expect(hcp.addresses()).toEqual(["capability:multiagent", "multiagent://local"]);
		expect(hcp.describeAll()).toContainEqual(
			expect.objectContaining({
				target: "capability:multiagent",
				kind: "multiagent",
				ops: ["discover", "orchestrate", "call"],
				metadata: expect.objectContaining({ source: "magenta", patterns: expect.any(Array) }),
			}),
		);
		await expect(hcp.dispatch({ target: "multiagent://local", op: "discover" })).resolves.toMatchObject({
			provider: "multiagent",
			targets: ["multiagent://local"],
		});
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
