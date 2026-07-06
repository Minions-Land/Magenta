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

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "..");
const indexPath = resolve(harnessRoot, "harness.toml");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const staleOnly = args.has("--stale");
const checkRule = args.has("--check");

// Capability kinds carry [assumption]; everything else must not.
//
// Single source of truth: CAPABILITY_KINDS in
// hcp-client/overlay/package-overlay.ts, parsed from source at runtime so this
// script cannot drift from it (no build dependency). We then union the
// intentional extras: `multiagent` is a capability magnet wired via the trunk
// barrel (assembly/sources.ts) that is deliberately NOT in the package-overlay
// set, because that set governs package-override eligibility, not "is-a-
// capability". See the decision matrix in docs/assumption-metadata.md.
const CAPABILITY_KIND_EXTRAS = ["multiagent"];

function loadCapabilityKinds() {
	const overlayPath = resolve(harnessRoot, "hcp-client/overlay/package-overlay.ts");
	let src;
	try {
		src = readFileSync(overlayPath, "utf-8");
	} catch {
		throw new Error(`cannot read ${overlayPath} to derive CAPABILITY_KINDS`);
	}
	const m = src.match(/export const CAPABILITY_KINDS = new Set<string>\(\[([\s\S]*?)\]\)/);
	if (!m) throw new Error("could not locate CAPABILITY_KINDS in package-overlay.ts");
	const kinds = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
	return new Set([...kinds, ...CAPABILITY_KIND_EXTRAS]);
}
const CAPABILITY_KINDS = loadCapabilityKinds();

// Minimal TOML reader: we only need [[components]] name/path and each
// component's [assumption] table. Reuse the built registry loader if present,
// else fall back to a tiny parser. To avoid a build dependency we parse the
// few fields we need directly.
function stripComments(line) {
	// remove trailing # comments not inside quotes (best-effort; our tomls are simple)
	let inStr = false;
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inStr) {
			if (c === quote) inStr = false;
		} else if (c === '"' || c === "'") {
			inStr = true;
			quote = c;
		} else if (c === "#") {
			return line.slice(0, i);
		}
	}
	return line;
}

function parseScalar(raw) {
	const v = raw.trim();
	if (v.startsWith("[")) {
		// simple inline array of strings
		return v
			.replace(/^\[/, "")
			.replace(/\]$/, "")
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	return v.replace(/^["']|["']$/g, "");
}

// Extract the [[components]] path list from harness.toml.
function parseComponentPaths(text) {
	const paths = [];
	const lines = text.split(/\r?\n/);
	let inComp = false;
	for (const rawLine of lines) {
		const line = stripComments(rawLine).trim();
		if (line === "[[components]]") {
			inComp = true;
			continue;
		}
		if (line.startsWith("[[") || line.startsWith("[")) {
			if (line !== "[[components]]") inComp = false;
		}
		if (inComp && line.startsWith("path")) {
			const eq = line.indexOf("=");
			if (eq >= 0) paths.push(parseScalar(line.slice(eq + 1)));
		}
	}
	return paths;
}

// Extract top-level name/kind and the [assumption] block from a component toml.
function parseComponent(text) {
	const lines = text.split(/\r?\n/);
	const top = {};
	const assumption = {};
	let section = "top";
	for (const rawLine of lines) {
		const line = stripComments(rawLine).trim();
		if (!line) continue;
		if (line.startsWith("[")) {
			section = line === "[assumption]" ? "assumption" : "other";
			continue;
		}
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const val = parseScalar(line.slice(eq + 1));
		if (section === "top") top[key] = val;
		else if (section === "assumption") assumption[key] = val;
	}
	return { top, assumption };
}

const indexText = await readFile(indexPath, "utf-8");
const compPaths = parseComponentPaths(indexText);

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
	const { top, assumption } = parseComponent(text);
	allComponents.push({ name: top.name ?? "?", kind: top.kind ?? "?", annotated: Object.keys(assumption).length > 0 });
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
	const missing = allComponents.filter((c) => CAPABILITY_KINDS.has(c.kind) && !c.annotated);
	const extra = allComponents.filter((c) => !CAPABILITY_KINDS.has(c.kind) && c.annotated);
	if (missing.length === 0 && extra.length === 0) {
		console.log(`Assumption placement OK: ${allComponents.filter((c) => c.annotated).length} capability component(s) annotated, no misplacements.`);
	} else {
		for (const c of missing) console.log(`MISSING  ${c.kind}:${c.name} is a capability kind but has no [assumption] block.`);
		for (const c of extra) console.log(`MISPLACED ${c.kind}:${c.name} is not a capability kind but carries an [assumption] block.`);
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
