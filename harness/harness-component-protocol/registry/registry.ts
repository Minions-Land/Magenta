import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Registry loader for the harness component model (spec §3, NO category middle
 * layer). Reads the top-level `harness.toml` index plus each referenced
 * per-component TOML and returns typed component descriptors.
 *
 * No TOML dependency is present in this monorepo (`@iarna/toml` / `smol-toml`
 * are absent from package.json and node_modules), so this module ships a MINIMAL
 * inline TOML-subset parser sufficient for these declarative files:
 * `key = value`, `[section]`, `[[array-of-tables]]`, plus string / array /
 * boolean / integer scalars. It is intentionally not a full TOML implementation.
 */

/** A parsed TOML value from the minimal subset parser. */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
/** A parsed TOML table. */
export interface TomlTable {
	[key: string]: TomlValue;
}

/** A component entry as declared in `harness.toml`'s `[[components]]` array. */
export interface ComponentRef {
	kind: string;
	name: string;
	description?: string;
	/** Path to the per-component TOML, relative to the index file or absolute. */
	path: string;
}

/** A fully loaded component descriptor (index entry + parsed component TOML). */
export interface ComponentDescriptor {
	kind: string;
	name: string;
	description?: string;
	/** Absolute path to the per-component TOML file. */
	path: string;
	/** The parsed per-component TOML table. */
	spec: TomlTable;
}

export type HarnessImplementationStatus = "ready" | "declared" | "inspect-only";

export interface HarnessImplementationDescriptor {
	/** Mature-agent harness source, e.g. pi, codex, jcode, claude-code. */
	source: string;
	status: HarnessImplementationStatus;
	/** Absolute path to the implementation source directory, when present. */
	path?: string;
	notes?: string;
}

export type HarnessModuleStatus = "ready" | "registered" | "inspect-only" | "core-exception";

export interface HarnessModuleDescriptor {
	id: string;
	kind: string;
	name: string;
	description?: string;
	/** Absolute path to the module descriptor TOML. */
	path: string;
	/** Stable capability slot represented by this module row. */
	capability: string;
	status: HarnessModuleStatus;
	coreException: boolean;
	implementations: HarnessImplementationDescriptor[];
	component: ComponentDescriptor;
}

/** Top-level registry: the index metadata plus all loaded components. */
export interface Registry {
	name?: string;
	description?: string;
	components: ComponentDescriptor[];
	modules: HarnessModuleDescriptor[];
}

/**
 * Locate the top-level harness registry file from either source or built output.
 *
 * Source builds execute this module from `harness/hcp/registry`; compiled
 * builds execute it from `harness/dist/hcp/registry`. Package installs
 * keep `harness.toml` at the package root, so we try each layout explicitly.
 */
export function getHarnessRegistryPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "../../harness.toml"),
		resolve(here, "../../../harness.toml"),
		resolve(here, "../../../../harness.toml"),
		resolve(process.cwd(), "harness", "harness.toml"),
		resolve(process.cwd(), "harness.toml"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error(`Unable to locate harness.toml. Tried: ${candidates.join(", ")}`);
}

/** Parse a single scalar TOML value (string, boolean, integer, or inline array). */
function parseScalar(raw: string): TomlValue {
	const value = raw.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (inner === "") return [];
		return splitTopLevel(inner).map((item) => parseScalar(item));
	}
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return unescapeString(value.slice(1, -1), value[0] === '"');
	}
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^[+-]?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
	// Fallback: treat as a bare string.
	return value;
}

/** Unescape a basic ("...") TOML string. Literal ('...') strings are returned as-is. */
function unescapeString(value: string, basic: boolean): string {
	if (!basic) return value;
	return value
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

/** Split a comma-separated list at the top level, respecting quotes and nested brackets. */
function splitTopLevel(input: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let current = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			current += ch;
			if (ch === quote && input[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "[") depth++;
		if (ch === "]") depth--;
		if (ch === "," && depth === 0) {
			if (current.trim() !== "") parts.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") parts.push(current.trim());
	return parts;
}

/** Strip a trailing unquoted `#` comment from a line. */
function stripComment(line: string): string {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote && line[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "#") return line.slice(0, i);
	}
	return line;
}

/**
 * Minimal TOML-subset parser. Supports `key = value`, `[section]`,
 * `[[array-of-tables]]`, dotted section paths, and string/array/bool/int/float
 * scalars. Not a full TOML implementation — sufficient for the declarative
 * registry files only.
 */
export function parseToml(source: string): TomlTable {
	const root: TomlTable = {};
	let current: TomlTable = root;
	let pendingKey: string | undefined;
	let pendingArray = "";

	const descend = (path: string[]): TomlTable => {
		let node = root;
		for (const key of path) {
			const existing = node[key];
			if (existing && typeof existing === "object" && !Array.isArray(existing)) {
				node = existing as TomlTable;
			} else {
				const next: TomlTable = {};
				node[key] = next;
				node = next;
			}
		}
		return node;
	};

	const rawLines = source.split(/\r?\n/);
	for (const rawLine of rawLines) {
		const line = stripComment(rawLine).trim();
		if (line === "") continue;

		if (pendingKey) {
			pendingArray = `${pendingArray}\n${line}`;
			if (line.endsWith("]")) {
				current[pendingKey] = parseScalar(pendingArray);
				pendingKey = undefined;
				pendingArray = "";
			}
			continue;
		}

		// [[array-of-tables]]
		if (line.startsWith("[[") && line.endsWith("]]")) {
			const path = line
				.slice(2, -2)
				.trim()
				.split(".")
				.map((s) => s.trim());
			const key = path[path.length - 1];
			const parent = descend(path.slice(0, -1));
			if (!parent[key]) {
				parent[key] = [];
			}
			const arr = parent[key] as TomlValue[];
			const entry: TomlTable = {};
			arr.push(entry);
			current = entry;
			continue;
		}

		// [section]
		if (line.startsWith("[") && line.endsWith("]")) {
			const path = line
				.slice(1, -1)
				.trim()
				.split(".")
				.map((s) => s.trim());
			current = descend(path);
			continue;
		}

		// key = value
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const rawValue = line.slice(eq + 1).trim();
		if (rawValue.startsWith("[") && !rawValue.endsWith("]")) {
			pendingKey = key;
			pendingArray = rawValue;
			continue;
		}
		const value = parseScalar(rawValue);
		current[key] = value;
	}

	return root;
}

function asString(value: TomlValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function _asTable(value: TomlValue | undefined): TomlTable | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function parseComponentRefs(indexTable: TomlTable): ComponentRef[] {
	const rawComponents = indexTable.components;
	return Array.isArray(rawComponents)
		? rawComponents
				.filter((c): c is TomlTable => typeof c === "object" && !Array.isArray(c))
				.map((c) => ({
					kind: asString(c.kind) ?? "",
					name: asString(c.name) ?? "",
					description: asString(c.description),
					path: asString(c.path) ?? "",
				}))
		: [];
}

const KNOWN_IMPLEMENTATION_SOURCES = new Set(["pi", "codex", "jcode", "claude-code", "magenta"]);

const CORE_EXCEPTION_MODULE_IDS = new Set(["assembly/hcp", "assembly/magnet"]);

export function buildHarnessModuleDescriptors(components: ComponentDescriptor[]): HarnessModuleDescriptor[] {
	return components.map((component) => {
		const id = `${component.kind}/${component.name}`;
		const implementations = listImplementations(component);
		const coreException = CORE_EXCEPTION_MODULE_IDS.has(id);
		const status: HarnessModuleStatus = coreException
			? "core-exception"
			: implementations.some((implementation) => implementation.status === "ready")
				? "ready"
				: component.kind === "contract"
					? "inspect-only"
					: "registered";
		return {
			id,
			kind: component.kind,
			name: component.name,
			description: component.description,
			path: component.path,
			capability: id,
			status,
			coreException,
			implementations,
			component,
		};
	});
}

function listImplementations(component: ComponentDescriptor): HarnessImplementationDescriptor[] {
	const componentDir = dirname(component.path);
	const implementations: HarnessImplementationDescriptor[] = [];
	if (existsSync(componentDir)) {
		for (const entry of readdirSync(componentDir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!entry.isDirectory() || !KNOWN_IMPLEMENTATION_SOURCES.has(entry.name)) continue;
			implementations.push({
				source: entry.name,
				status: "ready",
				path: resolve(componentDir, entry.name),
			});
		}
	}

	const declaredSource = asString(component.spec.source);
	if (declaredSource && !implementations.some((implementation) => implementation.source === declaredSource)) {
		implementations.push({
			source: declaredSource,
			status: component.kind === "contract" ? "inspect-only" : "declared",
			notes: "Declared in component TOML; no implementation source directory is present.",
		});
	}

	if (implementations.length === 0) {
		implementations.push({
			source: "registry",
			status: "inspect-only",
			notes: "No mature-agent implementation source directory is present.",
		});
	}

	return implementations;
}

/**
 * Load the harness registry: parse `rootTomlPath` (the `harness.toml` index),
 * then load each referenced per-component TOML and return typed descriptors.
 */
export async function loadRegistry(rootTomlPath: string): Promise<Registry> {
	const indexAbs = isAbsolute(rootTomlPath) ? rootTomlPath : resolve(rootTomlPath);
	const indexDir = dirname(indexAbs);
	const indexTable = parseToml(await readFile(indexAbs, "utf-8"));

	const refs = parseComponentRefs(indexTable);

	const components: ComponentDescriptor[] = [];
	for (const ref of refs) {
		if (!ref.path) continue;
		const compAbs = isAbsolute(ref.path) ? ref.path : resolve(indexDir, ref.path);
		const spec = parseToml(await readFile(compAbs, "utf-8"));
		components.push({
			kind: asString(spec.kind) ?? ref.kind,
			name: asString(spec.name) ?? ref.name,
			description: asString(spec.description) ?? ref.description,
			path: compAbs,
			spec,
		});
	}

	return {
		name: asString(indexTable.name),
		description: asString(indexTable.description),
		components,
		modules: buildHarnessModuleDescriptors(components),
	};
}
