// Turn a scenario TOML into a concrete run plan: for each variant, the exact
// headless-CLI argv that realizes its component on/off set.
//
// Kept dependency-free (small hand parser) so eval can run without a build.

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const harnessRoot = resolve(here, "..", "..");
export const repoRoot = resolve(harnessRoot, "..");
export const cliPath = resolve(repoRoot, "pi/coding-agent/dist/cli.js");

// component name -> the CLI flag(s) that turn it OFF. Absence of a flag = on.
const OFF_FLAG = {
	skills: ["--no-skills"],
	"prompt-templates": ["--no-prompt-templates"],
	context: ["--no-context-files"],
};
// A component with no CLI off-switch: the scenario must supply a manual_note.
const NO_CLI_OFF_SWITCH = new Set(["compaction", "memory", "hooks", "policy", "sandbox", "runtime", "system-prompt"]);

function stripComments(line) {
	let inStr = false;
	let q = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inStr) {
			if (c === q) inStr = false;
		} else if (c === '"' || c === "'") {
			inStr = true;
			q = c;
		} else if (c === "#") return line.slice(0, i);
	}
	return line;
}

function parseValue(raw) {
	const v = raw.trim();
	if (v === "true") return true;
	if (v === "false") return false;
	if (v.startsWith("{")) {
		// inline table: key = val, key = val
		const out = {};
		const body = v.replace(/^\{/, "").replace(/\}$/, "");
		for (const pair of splitTopLevel(body, ",")) {
			const eq = pair.indexOf("=");
			if (eq < 0) continue;
			out[pair.slice(0, eq).trim()] = parseValue(pair.slice(eq + 1));
		}
		return out;
	}
	if (v.startsWith("[")) {
		return splitTopLevel(v.replace(/^\[/, "").replace(/\]$/, ""), ",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	return v.replace(/^["']|["']$/g, "");
}

// split on a delimiter not inside quotes/braces/brackets
function splitTopLevel(s, delim) {
	const out = [];
	let depth = 0;
	let inStr = false;
	let q = "";
	let cur = "";
	for (const c of s) {
		if (inStr) {
			cur += c;
			if (c === q) inStr = false;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = true;
			q = c;
			cur += c;
			continue;
		}
		if (c === "{" || c === "[") depth++;
		if (c === "}" || c === "]") depth--;
		if (c === delim && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	if (cur.trim()) out.push(cur);
	return out;
}

// Minimal TOML: top-level scalars, [section], and [[array]] tables.
function parseToml(text) {
	const root = {};
	let cursor = root;
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = stripComments(rawLine).trim();
		if (!line) continue;
		if (line.startsWith("[[") && line.endsWith("]]")) {
			const key = line.slice(2, -2).trim();
			const path = key.split(".");
			let obj = root;
			for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]] ??= {};
			const arrKey = path[path.length - 1];
			obj[arrKey] ??= [];
			const entry = {};
			obj[arrKey].push(entry);
			cursor = entry;
			continue;
		}
		if (line.startsWith("[") && line.endsWith("]")) {
			const key = line.slice(1, -1).trim();
			const path = key.split(".");
			let obj = root;
			for (const p of path) obj = obj[p] ??= {};
			cursor = obj;
			continue;
		}
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		cursor[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1));
	}
	return root;
}

export async function loadScenario(nameOrPath) {
	const path = isAbsolute(nameOrPath)
		? nameOrPath
		: resolve(harnessRoot, "eval/scenarios", nameOrPath.endsWith(".toml") ? nameOrPath : `${nameOrPath}.toml`);
	const scenario = parseToml(await readFile(path, "utf-8"));
	scenario.__path = path;
	return scenario;
}

// Build the argv (minus prompt) for one variant.
export function variantArgv(variant, { model } = {}) {
	const argv = ["--print", "--mode", "json", "--no-session"];
	if (model) argv.push("--model", model);
	const warnings = [];
	const components = variant.components ?? {};
	for (const [name, on] of Object.entries(components)) {
		if (on) continue; // on = default, no flag
		if (OFF_FLAG[name]) argv.push(...OFF_FLAG[name]);
		else if (NO_CLI_OFF_SWITCH.has(name)) {
			warnings.push(
				`component '${name}' has no CLI off-switch; manual setup required` +
					(variant.manual_note ? ` — ${variant.manual_note}` : " (scenario provided no manual_note)"),
			);
		} else {
			warnings.push(`unknown component '${name}': cannot map to a CLI flag`);
		}
	}
	return { argv, warnings };
}

export async function buildPlan(scenario, { model } = {}) {
	const promptRef = scenario.prompt_ref
		? resolve(harnessRoot, "eval", scenario.prompt_ref)
		: null;
	const variants = (scenario.variant ?? scenario.variants ?? []).map((v) => {
		const { argv, warnings } = variantArgv(v, { model });
		return { name: v.name, argv, warnings, components: v.components ?? {} };
	});
	return {
		name: scenario.name,
		description: scenario.description,
		targetsComponent: scenario.targets_component,
		promptRef,
		cliPath,
		scoring: scenario.scoring ?? {},
		variants,
	};
}
