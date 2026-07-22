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
// A manual_note can explain missing isolation, but cannot make a real run executable.
const NO_CLI_OFF_SWITCH = new Set(["compaction", "memory", "hooks", "policy", "sandbox", "runtime", "system-prompt"]);
const CAPABILITY_COMPONENT = new Map([
	["workflows", "harness_workflows"],
	["multiagent", "harness_teammates"],
]);
const KNOWN_COMPONENTS = new Set([...Object.keys(OFF_FLAG), ...NO_CLI_OFF_SWITCH, ...CAPABILITY_COMPONENT.keys()]);
const SCENARIO_KINDS = new Set(["comparison", "smoke"]);

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
	if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(v)) return Number(v);
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

const BACKGROUND_POLICIES = new Set(["cancel", "wait", "error"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function finiteNonNegative(value, label, fallback) {
	const resolved = value ?? fallback;
	if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved < 0) {
		throw new Error(`${label} must be a non-negative number`);
	}
	return resolved;
}

function resolveCwd(value) {
	if (value === undefined) return repoRoot;
	if (typeof value !== "string" || value.length === 0) throw new Error("cwd must be a non-empty path");
	return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function mergeExpectations(base = {}, override = {}) {
	const merged = {
		capabilities: { ...(base.capabilities ?? {}), ...(override.capabilities ?? {}) },
		activeTools: override.active_tools ?? base.active_tools,
		activeToolsInclude: override.active_tools_include ?? base.active_tools_include ?? [],
		activeToolsExclude: override.active_tools_exclude ?? base.active_tools_exclude ?? [],
		successfulToolsInclude: override.successful_tools_include ?? base.successful_tools_include ?? [],
		requireWorkflowSubAgent: override.require_workflow_sub_agent ?? base.require_workflow_sub_agent ?? false,
		multiagentActionsInclude: override.multiagent_actions_include ?? base.multiagent_actions_include ?? [],
	};
	for (const [name, value] of Object.entries(merged.capabilities)) {
		if (typeof value !== "boolean") throw new Error(`expected capability '${name}' must be boolean`);
	}
	if (typeof merged.requireWorkflowSubAgent !== "boolean") {
		throw new Error("expect.require_workflow_sub_agent must be boolean");
	}
	for (const [label, value] of [
		["active_tools", merged.activeTools],
		["active_tools_include", merged.activeToolsInclude],
		["active_tools_exclude", merged.activeToolsExclude],
		["successful_tools_include", merged.successfulToolsInclude],
		["multiagent_actions_include", merged.multiagentActionsInclude],
	]) {
		if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
			throw new Error(`expect.${label} must be an array of tool names`);
		}
	}
	return merged;
}

// Build the argv (minus prompt) for one variant. Every element is passed to
// spawn() directly; no quoting or shell command construction is involved.
export function variantArgv(variant, { model, defaults = {} } = {}) {
	const argv = ["--print", "--mode", "json", "--no-session"];
	if (model) argv.push("--model", model);
	const warnings = [];
	const unresolvedManualIsolation = [];
	const components = variant.components ?? {};
	for (const [name, on] of Object.entries(components)) {
		if (typeof on !== "boolean") throw new Error(`component '${name}' state must be boolean`);
		if (!KNOWN_COMPONENTS.has(name)) {
			unresolvedManualIsolation.push({
				component: name,
				requestedState: on,
				reason: "unknown-component",
				manualNote: typeof variant.manual_note === "string" ? variant.manual_note : null,
			});
			warnings.push(`unknown component '${name}': real run blocked because it cannot map to a CLI control`);
			continue;
		}
		if (on || CAPABILITY_COMPONENT.has(name)) continue;
		if (OFF_FLAG[name]) argv.push(...OFF_FLAG[name]);
		else if (NO_CLI_OFF_SWITCH.has(name)) {
			unresolvedManualIsolation.push({
				component: name,
				requestedState: false,
				reason: "no-cli-off-switch",
				manualNote: typeof variant.manual_note === "string" ? variant.manual_note : null,
			});
			warnings.push(
				`component '${name}' has no CLI off-switch; real run blocked by unresolved manual isolation` +
					(variant.manual_note ? ` - ${variant.manual_note}` : " (scenario provided no manual_note)"),
			);
		}
	}

	const thinking = variant.thinking ?? defaults.thinking;
	if (thinking !== undefined) {
		if (!THINKING_LEVELS.has(thinking)) throw new Error(`invalid thinking level '${thinking}'`);
		argv.push("--thinking", thinking);
	}

	const workflowComponentState = components.workflows;
	const configuredWorkflows = variant.harness_workflows ?? defaults.harness_workflows;
	if (
		workflowComponentState !== undefined &&
		configuredWorkflows !== undefined &&
		workflowComponentState !== configuredWorkflows
	) {
		throw new Error("components.workflows conflicts with harness_workflows");
	}
	const workflows = configuredWorkflows ?? workflowComponentState;
	if (workflows !== undefined) {
		if (typeof workflows !== "boolean") throw new Error("harness_workflows must be boolean");
		argv.push(workflows ? "--harness-workflows" : "--no-harness-workflows");
	}
	const multiagentComponentState = components.multiagent;
	const configuredTeammates = variant.harness_teammates ?? defaults.harness_teammates;
	if (
		multiagentComponentState !== undefined &&
		configuredTeammates !== undefined &&
		multiagentComponentState !== configuredTeammates
	) {
		throw new Error("components.multiagent conflicts with harness_teammates");
	}
	const teammates = configuredTeammates ?? multiagentComponentState;
	if (teammates !== undefined) {
		if (typeof teammates !== "boolean") throw new Error("harness_teammates must be boolean");
		argv.push(teammates ? "--harness-teammates" : "--no-harness-teammates");
	}

	const backgroundPolicy = variant.background_policy ?? defaults.background_policy ?? "error";
	if (!BACKGROUND_POLICIES.has(backgroundPolicy)) throw new Error(`invalid background policy '${backgroundPolicy}'`);
	const backgroundWaitTimeoutSeconds = finiteNonNegative(
		variant.background_wait_timeout_seconds,
		"background_wait_timeout_seconds",
		defaults.background_wait_timeout_seconds ?? 60,
	);
	argv.push("--background-policy", backgroundPolicy, "--background-wait-timeout", String(backgroundWaitTimeoutSeconds));

	return {
		argv,
		warnings,
		isolation: {
			status: unresolvedManualIsolation.length === 0 ? "executable" : "unresolved-manual",
			unresolvedManualIsolation,
		},
		configuration: { thinking, workflows, teammates, backgroundPolicy, backgroundWaitTimeoutSeconds },
	};
}

export async function buildPlan(scenario, { model } = {}) {
	if (typeof scenario.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(scenario.name)) {
		throw new Error("scenario name must be filesystem-safe");
	}
	const kind = scenario.kind ?? "comparison";
	if (!SCENARIO_KINDS.has(kind)) throw new Error(`scenario kind must be one of: ${[...SCENARIO_KINDS].join(", ")}`);
	if (typeof scenario.targets_component !== "string" || scenario.targets_component.length === 0) {
		throw new Error("scenario targets_component must be a non-empty component name");
	}
	const promptRef = scenario.prompt_ref ? resolve(harnessRoot, "eval", scenario.prompt_ref) : null;
	const scenarioExpect = scenario.expect ?? {};
	const sourceVariants = scenario.variant ?? scenario.variants ?? [];
	if (!Array.isArray(sourceVariants) || sourceVariants.length === 0) throw new Error("scenario must define at least one variant");
	const variants = sourceVariants.map((v) => {
		if (typeof v.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v.name)) {
			throw new Error("variant name must be filesystem-safe");
		}
		const { argv, warnings, isolation, configuration } = variantArgv(v, { model, defaults: scenario });
		return {
			name: v.name,
			argv,
			warnings,
			isolation,
			components: v.components ?? {},
			configuration,
			cwd: resolveCwd(v.cwd ?? scenario.cwd),
			wallTimeoutMs:
				finiteNonNegative(v.wall_timeout_seconds, "wall_timeout_seconds", scenario.wall_timeout_seconds ?? 900) * 1000,
			expect: mergeExpectations(scenarioExpect, v.expect),
		};
	});
	const unresolvedManualIsolation = variants.flatMap((variant) =>
		variant.isolation.unresolvedManualIsolation.map((blocker) => ({ variant: variant.name, ...blocker })),
	);
	const targetStates = variants.map((variant) => variant.components[scenario.targets_component]);
	if (targetStates.some((state) => typeof state !== "boolean")) {
		unresolvedManualIsolation.push({
			variant: "<scenario>",
			component: scenario.targets_component,
			requestedState: null,
			reason: "target-not-declared",
			manualNote: null,
		});
	}
	if (kind === "comparison" && !(targetStates.includes(true) && targetStates.includes(false))) {
		unresolvedManualIsolation.push({
			variant: "<scenario>",
			component: scenario.targets_component,
			requestedState: null,
			reason: "target-not-varied",
			manualNote: null,
		});
	}
	return {
		schemaVersion: 1,
		name: scenario.name,
		kind,
		description: scenario.description,
		targetsComponent: scenario.targets_component,
		promptRef,
		cliPath,
		scoring: scenario.scoring ?? {},
		executionGate: {
			realRunAllowed: unresolvedManualIsolation.length === 0,
			unresolvedManualIsolation,
		},
		evidenceGate: {
			comparisonClaimAllowed: false,
			reasons:
				kind === "comparison"
					? ["fixed-variant-order", "shared-agent-environment", "single-repetition", "scoring-not-executed"]
					: ["scenario-kind-is-smoke"],
		},
		variants,
	};
}
