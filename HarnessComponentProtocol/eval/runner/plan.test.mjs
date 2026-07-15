import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, loadScenario, repoRoot, variantArgv } from "./plan.mjs";

test("variant argv maps headless execution controls to discrete arguments", () => {
	const result = variantArgv(
		{
			components: { skills: false },
			thinking: "ultra",
			harness_workflows: true,
			harness_teammates: false,
			background_policy: "wait",
			background_wait_timeout_seconds: 12.5,
		},
		{ model: "provider/model with spaces" },
	);
	assert.deepEqual(result.argv, [
		"--print",
		"--mode",
		"json",
		"--no-session",
		"--model",
		"provider/model with spaces",
		"--no-skills",
		"--thinking",
		"ultra",
		"--harness-workflows",
		"--no-harness-teammates",
		"--background-policy",
		"wait",
		"--background-wait-timeout",
		"12.5",
	]);
});

test("Ultra smoke scenario resolves the benchmark contract", async () => {
	const plan = await buildPlan(await loadScenario("ultra-orchestration-smoke"));
	assert.equal(plan.variants.length, 1);
	const variant = plan.variants[0];
	assert.equal(variant.cwd, repoRoot);
	assert.equal(variant.wallTimeoutMs, 900_000);
	assert.equal(variant.configuration.thinking, "ultra");
	assert.equal(variant.configuration.workflows, true);
	assert.equal(variant.configuration.teammates, true);
	assert.deepEqual(variant.expect.capabilities, { workflows: true, teammates: true });
	assert.deepEqual(variant.expect.activeToolsInclude, ["sub_agent", "teammate_agent", "bg_shell", "send_message"]);
});

test("invalid bounded run settings fail during plan construction", async () => {
	await assert.rejects(
		buildPlan({
			name: "bad",
			background_policy: "detach",
			variant: [{ name: "one" }],
		}),
		/invalid background policy/,
	);
});
