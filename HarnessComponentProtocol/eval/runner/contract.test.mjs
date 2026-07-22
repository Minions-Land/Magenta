import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEvalRun, validateAndNormalizeResult } from "./contract.mjs";

const variant = {
	name: "ultra",
	cwd: "/repo",
	wallTimeoutMs: 10_000,
	configuration: { thinking: "ultra", backgroundPolicy: "wait", backgroundWaitTimeoutSeconds: 5 },
	expect: {
		capabilities: { workflows: true, teammates: true },
		activeToolsInclude: ["sub_agent", "multiagent"],
		activeToolsExclude: ["ask_question"],
		successfulToolsInclude: ["sub_agent", "multiagent"],
		requireWorkflowSubAgent: true,
		multiagentActionsInclude: ["start", "stop"],
	},
};

function event(overrides = {}) {
	return {
		type: "runtime_manifest",
		protocolVersion: 1,
		runId: "run-1",
		product: { name: "magenta", version: "test", infrastructureVersion: "test" },
		cwd: "/repo",
		execution: { thinkingLevel: "xhigh", profile: "ultra", harnessCapabilities: { workflows: true, teammates: true } },
		tools: { active: ["multiagent", "sub_agent"] },
		policies: { background: { policy: "wait", waitTimeoutMs: 5000 } },
		...overrides,
	};
}

function end(overrides = {}) {
	return {
		type: "run_end",
		protocolVersion: 1,
		runId: "run-1",
		status: "success",
		exitCode: 0,
		durationMs: 4,
		stats: { messages: 2 },
		background: { policy: "wait", settled: true, events: [] },
		...overrides,
	};
}

function toolTrace() {
	return [
		{ type: "tool_execution_start", toolCallId: "sub-1", toolName: "sub_agent", args: { workflow: { pattern: "fan_out_synthesize" } } },
		{ type: "tool_execution_end", toolCallId: "sub-1", toolName: "sub_agent", isError: false, result: {} },
		...(["start", "stop"].flatMap((action, index) => [
			{ type: "tool_execution_start", toolCallId: `team-${index}`, toolName: "multiagent", args: { action } },
			{ type: "tool_execution_end", toolCallId: `team-${index}`, toolName: "multiagent", isError: false, result: {} },
		])),
	];
}

function completeEvents(manifest = event(), terminal = end()) {
	return [manifest, ...toolTrace(), terminal];
}

function result(events, overrides = {}) {
	return {
		code: 0,
		signal: null,
		timedOut: false,
		stdout: `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
		...overrides,
	};
}

test("accepts and normalizes one complete headless terminal contract", () => {
	const summary = validateAndNormalizeResult(result(completeEvents()), variant);
	assert.equal(summary.valid, true);
	assert.equal(summary.contractValid, true);
	assert.equal(summary.executionSucceeded, true);
	assert.deepEqual(summary.errors, []);
	assert.deepEqual(summary.runtime.activeTools, ["multiagent", "sub_agent"]);
	assert.deepEqual(summary.eventCounts, {
		run_end: 1,
		runtime_manifest: 1,
		tool_execution_end: 3,
		tool_execution_start: 3,
	});
	assert.equal(summary.toolEvidence.length, 3);
});

test("keeps a consistent failed process diagnosable without accepting it as a successful eval arm", () => {
	const summary = validateAndNormalizeResult(
		result(completeEvents(event(), end({ status: "error", exitCode: 1 })), { code: 1 }),
		variant,
	);

	assert.equal(summary.contractValid, true);
	assert.equal(summary.executionSucceeded, false);
	assert.equal(summary.valid, false);
	assert.deepEqual(summary.errors, []);
});

test("rejects malformed, missing, and duplicate terminal events", () => {
	const malformed = validateAndNormalizeResult({ ...result([event()]), stdout: "not-json\n" }, variant);
	assert.equal(malformed.valid, false);
	assert.match(malformed.errors.join("\n"), /malformed JSON/);
	assert.match(malformed.errors.join("\n"), /missing runtime_manifest/);
	assert.match(malformed.errors.join("\n"), /missing run_end/);

	const duplicate = validateAndNormalizeResult(result([event(), event(), ...toolTrace(), end(), end()]), variant);
	assert.match(duplicate.errors.join("\n"), /duplicate runtime_manifest/);
	assert.match(duplicate.errors.join("\n"), /duplicate run_end/);
});

test("rejects exit, capability, tool, and background mismatches", () => {
	const summary = validateAndNormalizeResult(
		result([
			event({
				execution: { harnessCapabilities: { workflows: false, teammates: true } },
				tools: { active: ["ask_question"] },
			}),
			end({ exitCode: 1, background: { policy: "wait", settled: false, events: [{ id: "bg-1", status: "running" }] } }),
		]),
		variant,
	);
	const errors = summary.errors.join("\n");
	assert.match(errors, /exit mismatch/);
	assert.match(errors, /capability workflows expected true/);
	assert.match(errors, /expected active tool 'sub_agent' is missing/);
	assert.match(errors, /unexpected active tool 'ask_question'/);
	assert.match(errors, /background work was not settled/);
	assert.match(errors, /background events that are still running/);
});

test("rejects missing orchestration tool evidence", () => {
	const summary = validateAndNormalizeResult(result([event(), end()]), variant);
	const errors = summary.errors.join("\n");
	assert.match(errors, /expected successful tool 'sub_agent'/);
	assert.match(errors, /workflow-based sub_agent/);
	assert.match(errors, /multiagent action 'stop'/);
});

test("rejects Ultra when the profile or native thinking resolution is wrong", () => {
	const standardProfile = validateAndNormalizeResult(
		result(completeEvents(event({ execution: { thinkingLevel: "xhigh", profile: "standard", harnessCapabilities: {} } }))),
		{ ...variant, expect: {} },
	);
	assert.match(standardProfile.errors.join("\n"), /execution profile expected ultra/);

	const literalUltra = validateAndNormalizeResult(
		result(completeEvents(event({ execution: { thinkingLevel: "ultra", profile: "ultra", harnessCapabilities: {} } }))),
		{ ...variant, expect: {} },
	);
	assert.match(literalUltra.errors.join("\n"), /must resolve to a native thinking level/);
});

test("rejects a runner wall timeout", () => {
	const summary = validateAndNormalizeResult(
		result(completeEvents(), { timedOut: true, code: null, signal: "SIGTERM" }),
		variant,
	);
	assert.match(summary.errors.join("\n"), /wall timeout exceeded/);
});

test("rejects truncated or failed stream capture and records finite stream metadata", () => {
	const summary = validateAndNormalizeResult(
		result(completeEvents(), {
			stdoutBytes: 64,
			stderrBytes: 32,
			stdoutObservedBytes: 80,
			stderrObservedBytes: 96,
			outputLimitBytes: 64,
			stdoutTruncated: true,
			stderrTruncated: true,
			captureErrors: { stderr: "disk full" },
		}),
		variant,
	);

	assert.equal(summary.valid, false);
	assert.match(summary.errors.join("\n"), /stdout exceeded the 64-byte capture limit/);
	assert.match(summary.errors.join("\n"), /stderr exceeded the 64-byte capture limit/);
	assert.match(summary.errors.join("\n"), /stderr capture failed: disk full/);
	assert.deepEqual(summary.process.streams.stdout, {
		bytes: 64,
		observedBytes: 80,
		limitBytes: 64,
		truncated: true,
	});
});

test("does not mark an unexecuted external scorer as a valid eval conclusion", () => {
	const arm = validateAndNormalizeResult(result(completeEvents()), variant);
	const summary = summarizeEvalRun(
		{
			name: "external-score",
			scoring: { method: "evaluator-agent" },
			evidenceGate: { comparisonClaimAllowed: false, reasons: ["fixed-variant-order"] },
		},
		[arm],
	);

	assert.equal(summary.contractValid, true);
	assert.equal(summary.executionSucceeded, true);
	assert.deepEqual(summary.scoring, { method: "evaluator-agent", status: "not_run", automatic: false });
	assert.equal(summary.valid, false);
	assert.equal(summary.evidence.comparisonClaimAllowed, false);
});

test("headless-contract scoring passes only when every arm succeeds", () => {
	const successful = validateAndNormalizeResult(result(completeEvents()), variant);
	const failed = validateAndNormalizeResult(
		result(completeEvents(event(), end({ status: "error", exitCode: 1 })), { code: 1 }),
		variant,
	);
	const plan = { name: "contract", scoring: { method: "headless-contract" }, evidenceGate: {} };

	assert.equal(summarizeEvalRun(plan, [successful]).valid, true);
	const summary = summarizeEvalRun(plan, [successful, failed]);
	assert.equal(summary.contractValid, true);
	assert.equal(summary.executionSucceeded, false);
	assert.deepEqual(summary.scoring, { method: "headless-contract", status: "failed", automatic: true });
	assert.equal(summary.valid, false);
});
