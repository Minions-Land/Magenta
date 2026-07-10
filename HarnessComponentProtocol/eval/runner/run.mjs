#!/usr/bin/env node
// Run (or dry-run) a harness eval scenario.
//
//   node eval/runner/run.mjs <scenario> --dry-run
//   node eval/runner/run.mjs <scenario> --model <id>
//
// --dry-run prints the exact CLI invocations + scoring plan and exits 0 without
// calling any model. It is the CI-safe check that the eval plumbing is intact.
//
// A real run shells out to the built headless CLI for each variant, writes
// transcripts under results/<scenario>-<timestamp>/, and prints a comparison.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPlan, harnessRoot, loadScenario } from "./plan.mjs";

const argv = process.argv.slice(2);
const scenarioName = argv.find((a) => !a.startsWith("--"));
const dryRun = argv.includes("--dry-run");
const modelIdx = argv.indexOf("--model");
const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;

if (!scenarioName) {
	console.error("usage: run.mjs <scenario> [--dry-run] [--model <id>]");
	process.exit(2);
}

const scenario = await loadScenario(scenarioName);
const plan = await buildPlan(scenario, { model });

const prompt = plan.promptRef ? await readFile(plan.promptRef, "utf-8") : "";

function printPlan() {
	console.log(`\nScenario: ${plan.name}`);
	console.log(`  ${plan.description}`);
	console.log(`  targets component: ${plan.targetsComponent}`);
	console.log(`  cli: ${plan.cliPath}`);
	console.log(`  prompt: ${plan.promptRef ?? "(none)"} (${prompt.length} chars)`);
	console.log(`  scoring: ${JSON.stringify(plan.scoring)}`);
	console.log("\nVariants:");
	for (const v of plan.variants) {
		console.log(`\n  [${v.name}] components=${JSON.stringify(v.components)}`);
		console.log(`    argv: node ${plan.cliPath} ${v.argv.join(" ")} -p <prompt>`);
		for (const w of v.warnings) console.log(`    ! ${w}`);
	}
	console.log("");
}

if (dryRun) {
	printPlan();
	if (!existsSync(plan.cliPath)) {
		console.log(`note: built CLI not found at ${plan.cliPath}; a real run needs it built first.`);
	}
	console.log("dry-run OK (no model calls made).");
	process.exit(0);
}

// ---- real run ----------------------------------------------------------------
if (!existsSync(plan.cliPath)) {
	console.error(`error: built CLI not found at ${plan.cliPath}. Build the coding-agent first.`);
	process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(harnessRoot, "eval/results", `${plan.name}-${stamp}`);
await mkdir(outDir, { recursive: true });

function runVariant(v) {
	return new Promise((resolveRun) => {
		const args = [plan.cliPath, ...v.argv, "-p", prompt];
		const child = spawn("node", args, { cwd: harnessRoot });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => resolveRun({ name: v.name, code, stdout, stderr }));
	});
}

console.log(`Running ${plan.variants.length} variant(s) for '${plan.name}'${model ? ` on ${model}` : ""}...`);
const results = [];
for (const v of plan.variants) {
	if (v.warnings.length) {
		console.log(`\n[${v.name}] WARNINGS — variant may not be correctly isolated:`);
		for (const w of v.warnings) console.log(`  ! ${w}`);
	}
	console.log(`\n[${v.name}] running...`);
	const r = await runVariant(v);
	await writeFile(resolve(outDir, `${v.name}.stdout.json`), r.stdout);
	if (r.stderr) await writeFile(resolve(outDir, `${v.name}.stderr.txt`), r.stderr);
	console.log(`[${v.name}] exit ${r.code}, ${r.stdout.length} bytes stdout`);
	results.push(r);
}

await writeFile(
	resolve(outDir, "plan.json"),
	JSON.stringify({ plan, model: model ?? null, variants: results.map((r) => ({ name: r.name, code: r.code })) }, null, 2),
);

console.log(`\nTranscripts written to ${outDir}`);
console.log(
	"Scoring is not automated in this scaffold: apply the scenario's [scoring] method " +
		"(evaluator-agent via multiagent adversarial_verify, plus the mechanical signals) " +
		"to the transcripts, then update the target component's [assumption].load_bearing.",
);
