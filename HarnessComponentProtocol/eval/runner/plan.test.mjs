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
	assert.deepEqual(result.isolation, { status: "executable", unresolvedManualIsolation: [] });
});

test("Ultra smoke scenario resolves the benchmark contract", async () => {
	const plan = await buildPlan(await loadScenario("ultra-orchestration-smoke"));
	assert.equal(plan.kind, "smoke");
	assert.deepEqual(plan.executionGate, { realRunAllowed: true, unresolvedManualIsolation: [] });
	assert.deepEqual(plan.evidenceGate, {
		comparisonClaimAllowed: false,
		reasons: ["scenario-kind-is-smoke"],
	});
	assert.equal(plan.variants.length, 1);
	const variant = plan.variants[0];
	assert.equal(variant.cwd, repoRoot);
	assert.equal(variant.wallTimeoutMs, 900_000);
	assert.equal(variant.configuration.thinking, "ultra");
	assert.equal(variant.configuration.workflows, true);
	assert.equal(variant.configuration.teammates, true);
	assert.deepEqual(variant.expect.capabilities, { workflows: true, teammates: true });
	assert.deepEqual(variant.expect.activeToolsInclude, ["sub_agent", "multiagent", "bg_shell", "send_message"]);
});

test("long-horizon plan exposes unresolved manual isolation structurally", async () => {
	const plan = await buildPlan(await loadScenario("long-horizon-coherence"));
	assert.equal(plan.executionGate.realRunAllowed, false);
	assert.deepEqual(plan.executionGate.unresolvedManualIsolation, [
		{
			variant: "compaction-off",
			component: "compaction",
			requestedState: false,
			reason: "no-cli-off-switch",
			manualNote:
				"Unresolved: Magenta has no executable compaction-off CLI flag. Any external comparison needs separately recorded isolation and provenance; this runner cannot claim it as an A/B result.",
		},
	]);
	assert.equal(plan.variants[0].isolation.status, "executable");
	assert.equal(plan.variants[1].isolation.status, "unresolved-manual");
});

test("unknown component switches fail closed instead of producing an unisolated run", () => {
	const result = variantArgv({ components: { misspelled_component: false } });
	assert.deepEqual(result.isolation, {
		status: "unresolved-manual",
		unresolvedManualIsolation: [
			{
				component: "misspelled_component",
				requestedState: false,
				reason: "unknown-component",
				manualNote: null,
			},
		],
	});
});

test("unknown enabled components fail closed instead of passing through truthiness", () => {
	const result = variantArgv({ components: { misspelled_component: true } });
	assert.deepEqual(result.isolation, {
		status: "unresolved-manual",
		unresolvedManualIsolation: [
			{
				component: "misspelled_component",
				requestedState: true,
				reason: "unknown-component",
				manualNote: null,
			},
		],
	});
});

test("non-boolean component states are rejected during plan construction", () => {
	assert.throws(() => variantArgv({ components: { skills: "false" } }), /component 'skills' state must be boolean/);
});

test("comparison scenarios that do not vary their target fail closed", async () => {
	const plan = await buildPlan({
		name: "not-varied",
		targets_component: "skills",
		variant: [
			{ name: "first", components: { skills: true } },
			{ name: "second", components: { skills: true } },
		],
	});

	assert.equal(plan.executionGate.realRunAllowed, false);
	assert.ok(
		plan.executionGate.unresolvedManualIsolation.some(
			(blocker) => blocker.component === "skills" && blocker.reason === "target-not-varied",
		),
	);
});

test("every variant must declare the target component explicitly", async () => {
	const plan = await buildPlan({
		name: "target-missing",
		targets_component: "skills",
		variant: [
			{ name: "on", components: { skills: true } },
			{ name: "missing", components: {} },
		],
	});

	assert.equal(plan.executionGate.realRunAllowed, false);
	assert.ok(
		plan.executionGate.unresolvedManualIsolation.some(
			(blocker) => blocker.component === "skills" && blocker.reason === "target-not-declared",
		),
	);
});

test("invalid bounded run settings fail during plan construction", async () => {
	await assert.rejects(
		buildPlan({
			name: "bad",
			kind: "smoke",
			targets_component: "skills",
			background_policy: "detach",
			variant: [{ name: "one", components: { skills: true } }],
		}),
		/invalid background policy/,
	);
});
