#!/usr/bin/env node
// Run (or dry-run) a harness eval scenario.
//
//   node eval/runner/run.mjs <scenario> --dry-run
//   node eval/runner/run.mjs <scenario> --model <id>
//
// --dry-run resolves process argument arrays without calling a model. A real
// run executes each bounded headless variant, retains both raw streams, and
// validates the versioned JSONL terminal contract into normalized summaries.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	cleanupEvalResults,
	createEvalRunDirectory,
	runBoundedProcess,
	writePrivateArtifact,
} from "./artifacts.mjs";
import { summarizeEvalRun, validateAndNormalizeResult } from "./contract.mjs";
import { assertRealRunIsolation } from "./execution-gate.mjs";
import { buildPlan, harnessRoot, loadScenario } from "./plan.mjs";

function parseRunnerArgs(args) {
	let scenarioName;
	let model;
	let dryRun = false;
	let json = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") dryRun = true;
		else if (arg === "--json") json = true;
		else if (arg === "--model") {
			model = args[++index];
			if (!model) throw new Error("--model requires an id");
		} else if (arg.startsWith("--")) throw new Error(`unknown runner option '${arg}'`);
		else if (scenarioName === undefined) scenarioName = arg;
		else throw new Error(`unexpected positional argument '${arg}'`);
	}
	if (!scenarioName) throw new Error("usage: run.mjs <scenario> [--dry-run] [--json] [--model <id>]");
	return { scenarioName, model, dryRun, json };
}

let options;
try {
	options = parseRunnerArgs(process.argv.slice(2));
} catch (error) {
	console.error(error.message);
	process.exit(2);
}

const { scenarioName, model, dryRun, json } = options;
const scenario = await loadScenario(scenarioName);
const plan = await buildPlan(scenario, { model });

if (!dryRun) {
	try {
		assertRealRunIsolation(plan);
	} catch (error) {
		console.error(`error: ${error.message}`);
		process.exit(1);
	}
}

const prompt = plan.promptRef ? await readFile(plan.promptRef, "utf-8") : "";

function printablePlan() {
	return { ...plan, model: model ?? null, promptBytes: Buffer.byteLength(prompt) };
}

function printPlan() {
	if (json) {
		console.log(JSON.stringify(printablePlan(), null, 2));
		return;
	}
	console.log(`\nScenario: ${plan.name}`);
	console.log(`  ${plan.description}`);
	console.log(`  targets component: ${plan.targetsComponent}`);
	console.log(`  cli: ${plan.cliPath}`);
	console.log(`  prompt: ${plan.promptRef ?? "(none)"} (${Buffer.byteLength(prompt)} bytes)`);
	console.log(`  scoring: ${JSON.stringify(plan.scoring)}`);
	console.log(`  real run: ${plan.executionGate.realRunAllowed ? "READY" : "BLOCKED (unresolved manual isolation)"}`);
	for (const blocker of plan.executionGate.unresolvedManualIsolation) {
		console.log(
			`    ! variant '${blocker.variant}' cannot prove component '${blocker.component}' state ${String(blocker.requestedState)}: ${blocker.reason}`,
		);
		if (blocker.manualNote) console.log(`      manual note: ${blocker.manualNote}`);
	}
	console.log("\nVariants:");
	for (const variant of plan.variants) {
		console.log(`\n  [${variant.name}] cwd=${variant.cwd} wallTimeoutMs=${variant.wallTimeoutMs}`);
		console.log(`    argv: ${JSON.stringify([process.execPath, plan.cliPath, ...variant.argv, "-p", "<prompt>"])}`);
		console.log(`    expect: ${JSON.stringify(variant.expect)}`);
		for (const warning of variant.warnings) console.log(`    ! ${warning}`);
	}
	console.log("");
}

if (dryRun) {
	printPlan();
	if (!existsSync(plan.cliPath) && !json) {
		console.log(`note: built CLI not found at ${plan.cliPath}; a real run needs it built first.`);
	}
	if (!json) {
		console.log(
			plan.executionGate.realRunAllowed
				? "dry-run OK (no model calls made)."
				: "dry-run complete (no model calls made; real run remains blocked).",
		);
	}
	process.exit(0);
}

if (!existsSync(plan.cliPath)) {
	console.error(`error: built CLI not found at ${plan.cliPath}. Build the coding-agent first.`);
	process.exit(1);
}

const resultsRoot = resolve(harnessRoot, "eval/results");
const activeRun = await createEvalRunDirectory(resultsRoot, plan.name);
const outDir = activeRun.path;
try {
	await cleanupEvalResults(resultsRoot, { protectedPrefixes: [outDir] }).catch(() => undefined);
	await writePrivateArtifact(resolve(outDir, "plan.json"), `${JSON.stringify(printablePlan(), null, 2)}\n`);

	if (!json) {
		console.log(`Running ${plan.variants.length} variant(s) for '${plan.name}'${model ? ` on ${model}` : ""}...`);
	}
	const summaries = [];
	for (const variant of plan.variants) {
		if (!json && variant.warnings.length) {
			console.log(`\n[${variant.name}] WARNINGS - variant may not be correctly isolated:`);
			for (const warning of variant.warnings) console.log(`  ! ${warning}`);
		}
		if (!json) console.log(`\n[${variant.name}] running...`);
		const result = await runBoundedProcess({
			executable: process.execPath,
			args: [plan.cliPath, ...variant.argv, "-p", prompt],
			cwd: variant.cwd,
			wallTimeoutMs: variant.wallTimeoutMs,
			stdoutPath: resolve(outDir, `${variant.name}.stdout.jsonl`),
			stderrPath: resolve(outDir, `${variant.name}.stderr.log`),
		});
		const summary = validateAndNormalizeResult(result, variant);
		await writePrivateArtifact(resolve(outDir, `${variant.name}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
		summaries.push(summary);
		if (!json) {
			console.log(
				`[${variant.name}] process exit ${String(result.code)}, contract ${summary.contractValid ? "valid" : "INVALID"}, execution ${summary.executionSucceeded ? "succeeded" : "FAILED"}, ${result.stdoutBytes} stdout bytes retained`,
			);
			for (const error of summary.errors) console.log(`  ! ${error}`);
		}
	}

	const runSummary = summarizeEvalRun(plan, summaries, { model: model ?? null, resultsDirectory: outDir });
	await writePrivateArtifact(resolve(outDir, "summary.json"), `${JSON.stringify(runSummary, null, 2)}\n`);

	if (json) console.log(JSON.stringify(runSummary));
	else console.log(`\nRaw logs and normalized summaries written to ${outDir}`);
	if (!runSummary.valid) process.exitCode = 1;
} finally {
	await cleanupEvalResults(resultsRoot, { protectedPrefixes: [outDir] }).catch(() => undefined);
	await activeRun.release();
}
