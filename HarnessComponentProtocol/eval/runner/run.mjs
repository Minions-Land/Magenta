#!/usr/bin/env node
// Run (or dry-run) a harness eval scenario.
//
//   node eval/runner/run.mjs <scenario> --dry-run
//   node eval/runner/run.mjs <scenario> --model <id>
//
// --dry-run resolves process argument arrays without calling a model. A real
// run executes each bounded headless variant, retains both raw streams, and
// validates the versioned JSONL terminal contract into normalized summaries.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateAndNormalizeResult } from "./contract.mjs";
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
	if (!json) console.log("dry-run OK (no model calls made).");
	process.exit(0);
}

if (!existsSync(plan.cliPath)) {
	console.error(`error: built CLI not found at ${plan.cliPath}. Build the coding-agent first.`);
	process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(harnessRoot, "eval/results", `${plan.name}-${stamp}`);
await mkdir(outDir, { recursive: true });

function runVariant(variant) {
	return new Promise((resolveRun) => {
		const args = [plan.cliPath, ...variant.argv, "-p", prompt];
		const child = spawn(process.execPath, args, {
			cwd: variant.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnError;
		let killTimer;
		const wallTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			killTimer.unref();
		}, variant.wallTimeoutMs);
		wallTimer.unref();
		child.stdout?.on("data", (data) => (stdout += data));
		child.stderr?.on("data", (data) => (stderr += data));
		child.on("error", (error) => (spawnError = error.message));
		child.on("close", (code, signal) => {
			clearTimeout(wallTimer);
			if (killTimer) clearTimeout(killTimer);
			resolveRun({ name: variant.name, code, signal, timedOut, spawnError, stdout, stderr });
		});
	});
}

if (!json) console.log(`Running ${plan.variants.length} variant(s) for '${plan.name}'${model ? ` on ${model}` : ""}...`);
const summaries = [];
for (const variant of plan.variants) {
	if (!json && variant.warnings.length) {
		console.log(`\n[${variant.name}] WARNINGS - variant may not be correctly isolated:`);
		for (const warning of variant.warnings) console.log(`  ! ${warning}`);
	}
	if (!json) console.log(`\n[${variant.name}] running...`);
	const result = await runVariant(variant);
	await writeFile(resolve(outDir, `${variant.name}.stdout.jsonl`), result.stdout);
	await writeFile(resolve(outDir, `${variant.name}.stderr.log`), result.stderr);
	const summary = validateAndNormalizeResult(result, variant);
	await writeFile(resolve(outDir, `${variant.name}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
	summaries.push(summary);
	if (!json) {
		console.log(
			`[${variant.name}] process exit ${String(result.code)}, contract ${summary.valid ? "valid" : "INVALID"}, ${result.stdout.length} stdout bytes`,
		);
		for (const error of summary.errors) console.log(`  ! ${error}`);
	}
}

const runSummary = {
	schemaVersion: 1,
	scenario: plan.name,
	valid: summaries.every((summary) => summary.valid),
	model: model ?? null,
	resultsDirectory: outDir,
	variants: summaries,
};
await writeFile(resolve(outDir, "plan.json"), `${JSON.stringify(printablePlan(), null, 2)}\n`);
await writeFile(resolve(outDir, "summary.json"), `${JSON.stringify(runSummary, null, 2)}\n`);

if (json) console.log(JSON.stringify(runSummary));
else console.log(`\nRaw logs and normalized summaries written to ${outDir}`);
if (!runSummary.valid) process.exitCode = 1;
