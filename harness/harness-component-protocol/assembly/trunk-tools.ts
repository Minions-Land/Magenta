/**
 * Trunk tool assembly — load harness.toml trunk components (web-search,
 * web-fetch) as AgentTools for the pi loop to call directly.
 *
 * This bypasses package overlay and directly assembles tools from harness.toml
 * trunk components, making them available to the default agent runtime.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadProcessToolManifest, ProcessToolMagnet, type ProcessToolManifest } from "../magnet/process.ts";
import type { SandboxProfile } from "../../modules/sandbox/magenta/sandbox.ts";
import { loadSandboxProviderFromPack, selectSandboxProfile } from "../../modules/sandbox/magenta/sandbox.ts";
import { parseToml, type TomlTable } from "../registry/registry.ts";

export interface TrunkToolsOptions {
	/** Working directory for tool execution (the user's workspace). */
	cwd: string;
	/**
	 * Harness source root that contains harness.toml, modules/, and the built
	 * Rust binaries under modules/.../target/release. Defaults to the harness
	 * package root derived from this module's location, which is correct in both
	 * the compiled (dist) and source layouts.
	 */
	harnessRoot?: string;
	/** Optional env for tool execution. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Tool names to assemble. If undefined, assembles all recognized trunk tools.
	 * Currently recognized: web-search, web-fetch.
	 */
	names?: string[];
}

interface HarnessComponentEntry {
	kind: string;
	name: string;
	description?: string;
	path: string;
	source?: string;
	origin?: string;
	implementation_manifest?: string;
}

const RECOGNIZED_TRUNK_TOOLS = new Set(["web-search", "web-fetch"]);

/**
 * Assemble harness trunk tools (web-search, web-fetch) as AgentTools ready for
 * the pi loop to call. These are pulled directly from harness.toml trunk
 * components, not from package overlay.
 *
 * Returns an array of AgentTools built from ProcessToolMagnet.toTool().
 */
export async function assembleTrunkTools(options: TrunkToolsOptions): Promise<AgentTool[]> {
	const harnessRoot = options.harnessRoot ?? deriveHarnessRoot();
	const harnessTomlPath = resolve(harnessRoot, "harness.toml");
	const harnessToml = parseToml(await readFile(harnessTomlPath, "utf-8"));

	const components = asComponentArray(harnessToml.components);
	const toolComponents = components.filter((c) => c.kind === "tool" && RECOGNIZED_TRUNK_TOOLS.has(c.name));

	const selectedTools =
		options.names && options.names.length > 0
			? toolComponents.filter((c) => options.names!.includes(c.name))
			: toolComponents;

	const tools: AgentTool[] = [];
	for (const component of selectedTools) {
		// harness.toml points at the OUTER descriptor (e.g.
		// modules/tools/web-search/web-search.toml), which in turn declares
		// `implementation_manifest` relative to itself (e.g. magenta/web-search.toml).
		const outerPath = resolve(harnessRoot, component.path);
		const outerToml = parseToml(await readFile(outerPath, "utf-8"));
		const implManifest = asString(outerToml.implementation_manifest);
		if (!implManifest) continue;

		const manifestPath = resolve(dirname(outerPath), implManifest);
		const manifest = await loadProcessToolManifest(manifestPath);
		const sandboxProfile = await loadTrunkSandboxProfile(harnessRoot, manifest);

		const magnet = new ProcessToolMagnet({
			manifest,
			// The manifest `command` is repo-relative in the Magenta1 style
			// (e.g. "tools/web-search/magenta/process-tools/target/release/..."),
			// which resolves against harness/modules.
			manifestRoot: resolve(harnessRoot, "modules"),
			cwd: options.cwd,
			env: options.env,
			sandboxProfile,
		});

		tools.push(magnet.toTool());
	}

	return tools;
}

function asComponentArray(value: unknown): HarnessComponentEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is TomlTable => item !== null && typeof item === "object" && !Array.isArray(item))
		.map((item) => ({
			kind: asString(item.kind) ?? "",
			name: asString(item.name) ?? "",
			description: asString(item.description),
			path: asString(item.path) ?? "",
			source: asString(item.source),
			origin: asString(item.origin),
			implementation_manifest: asString(item.implementation_manifest),
		}))
		.filter((c) => c.kind && c.name && c.path);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Derive the harness package root from this module's own location by walking up
 * until harness.toml is found. Robust across layouts: source
 * (harness-component-protocol/assembly/trunk-tools.ts, 2 levels below root) and compiled
 * (dist/harness-component-protocol/assembly/trunk-tools.js, 3 levels below root).
 */
function deriveHarnessRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		if (existsSync(resolve(dir, "harness.toml"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fallback: assume the compiled dist layout (3 levels below the root).
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Resolve the sandbox profile for a trunk tool, mirroring
 * `loadCatalogSandboxProfile` in the catalog assembly path. Network-tagged
 * tools (web-search/web-fetch) select the `network-read` profile so their
 * outbound requests are permitted; without a profile the runtime defaults to
 * network=deny and rejects them.
 */
async function loadTrunkSandboxProfile(
	harnessRoot: string,
	manifest: ProcessToolManifest,
): Promise<SandboxProfile | undefined> {
	const packPath = resolve(harnessRoot, "modules/sandbox/sandbox.toml");
	const provider = await loadSandboxProviderFromPack(packPath);
	const selection = selectSandboxProfile({
		tool: {
			name: manifest.name,
			operation: manifest.operation,
			read_only: manifest.read_only ?? false,
			destructive: manifest.destructive ?? false,
			tags: manifest.tags ?? [],
		},
	});
	return provider.get(selection.profile);
}
