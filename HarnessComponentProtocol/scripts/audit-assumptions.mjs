#!/usr/bin/env node
// Audit component [assumption] metadata.
//
// Lists every capability component's assumption block so we can answer, when a
// model changes, "what should I re-check, and what can I stop doing?"
//
// Usage:
//   node scripts/audit-assumptions.mjs                 # full table
//   node scripts/audit-assumptions.mjs --stale         # only components needing attention
//   node scripts/audit-assumptions.mjs --check         # enforce placement rule (CI gate)
//   node scripts/audit-assumptions.mjs --json          # machine-readable
//
// --check verifies the placement RULE: every capability-kind component carries
// an [assumption] block and no other kind does. Exit code is non-zero on any
// violation, so CI can enforce that the rule stays consistent as components are
// added. In --stale mode the exit code is non-zero if any capability component
// is suspected-stale or dead-weight, flagging pruning candidates.

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "..");
const indexPath = resolve(harnessRoot, "harness.toml");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const staleOnly = args.has("--stale");
const checkRule = args.has("--check");

const indexText = await readFile(indexPath, "utf-8");
const index = parse(indexText);
const compPaths = (Array.isArray(index.components) ? index.components : [])
	.map((component) => component?.path)
	.filter((path) => typeof path === "string");

const rows = [];
const allComponents = [];
for (const p of compPaths) {
	const abs = isAbsolute(p) ? p : resolve(harnessRoot, p);
	let text;
	try {
		text = await readFile(abs, "utf-8");
	} catch {
		continue;
	}
	const top = parse(text);
	const assumption =
		top.assumption && typeof top.assumption === "object" && !Array.isArray(top.assumption) ? top.assumption : {};
	allComponents.push({
		name: top.name ?? "?",
		kind: top.kind ?? "?",
		product: top.product ?? "?",
		annotated: Object.keys(assumption).length > 0,
	});
	if (Object.keys(assumption).length === 0) continue; // only annotated components
	rows.push({
		name: top.name ?? "?",
		kind: top.kind ?? "?",
		compensates: assumption.compensates ?? "",
		rationale: assumption.rationale ?? "",
		calibrated_for: assumption.calibrated_for ?? [],
		review_trigger: assumption.review_trigger ?? "",
		load_bearing: assumption.load_bearing ?? "",
		eval_scenarios: assumption.eval_scenarios ?? [],
	});
}

const needsAttention = (r) =>
	r.load_bearing === "suspected-stale" || r.load_bearing === "dead-weight" || r.load_bearing === "unmeasured";

// --check: enforce the placement RULE (uniformity = consistent rule, not a block
// on every file). Every capability-kind component must carry [assumption];
// no other kind may. Exits non-zero on any violation.
if (checkRule) {
	const missing = allComponents.filter((c) => c.product === "capability" && !c.annotated);
	const extra = allComponents.filter((c) => c.product !== "capability" && c.annotated);
	if (missing.length === 0 && extra.length === 0) {
		console.log(`Assumption placement OK: ${allComponents.filter((c) => c.annotated).length} capability component(s) annotated, no misplacements.`);
	} else {
		for (const c of missing) console.log(`MISSING  ${c.kind}:${c.name} has product=capability but no [assumption] block.`);
		for (const c of extra) console.log(`MISPLACED ${c.kind}:${c.name} has product=${c.product} but carries an [assumption] block.`);
		process.exitCode = 1;
	}
	// --check is a standalone gate; do not also print the table.
	if (!asJson && !staleOnly) process.exit(process.exitCode ?? 0);
}

const filtered = staleOnly ? rows.filter(needsAttention) : rows;

if (asJson) {
	console.log(JSON.stringify(filtered, null, 2));
} else {
	if (filtered.length === 0) {
		console.log("No matching annotated components.");
	} else {
		for (const r of filtered) {
			console.log(`\n${r.kind}:${r.name}`);
			console.log(`  load_bearing : ${r.load_bearing}  (review: ${r.review_trigger})`);
			console.log(`  rationale    : ${r.rationale}`);
			console.log(`  calibrated   : ${Array.isArray(r.calibrated_for) ? r.calibrated_for.join(", ") : r.calibrated_for}`);
			console.log(`  eval         : ${Array.isArray(r.eval_scenarios) && r.eval_scenarios.length ? r.eval_scenarios.join(", ") : "(none)"}`);
			console.log(`  compensates  : ${r.compensates}`);
		}
		console.log(`\n${filtered.length} component(s).`);
	}
}

// In --stale mode, exit non-zero if any capability component (model-change
// trigger) is unmeasured/stale/dead — a signal that eval coverage is missing.
if (staleOnly) {
	const flagged = filtered.filter((r) => r.review_trigger === "model-change" && needsAttention(r));
	if (flagged.length > 0) process.exitCode = 1;
}
