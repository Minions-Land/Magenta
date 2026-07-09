import { buildDefaultCapabilityHcp } from "./capability.ts";
import { HcpClient } from "../hcp-client.ts";
import {
	assemblePackageToolMagnets,
	getHarnessPackagesRoot,
	type PackageDiagnostic,
	type PackageOverlay,
} from "../overlay/package-overlay.ts";
import type { HcpMagnet } from "../../hcp-client/contract/hcp-magnet.ts";
import { NativeToolMagnet } from "../../hcp-magnet/native.ts";
import { ModuleHcpServer } from "../../hcp-magnet/module-server.ts";
import {
	BASH_TOOL_DESCRIPTION,
	type BashExecuteOptions,
	bashSchema,
	createBashExecute,
} from "../../modules/tools/bash/pi/bash.ts";
import { createReadExecute, type ReadToolOptions, readSchema } from "../../modules/tools/read/pi/read.ts";
import { createEditExecute, type EditToolOptions, editSchema } from "../../modules/tools/edit/pi/edit.ts";
import { createWriteExecute, type WriteToolOptions, writeSchema } from "../../modules/tools/write/pi/write.ts";
import { createGrepExecute, GREP_DESCRIPTION, type GrepToolOptions, grepSchema } from "../../modules/tools/grep/pi/grep.ts";
import { createFindExecute, type FindToolOptions, findSchema } from "../../modules/tools/find/pi/find.ts";
import { createLsExecute, type LsToolOptions, lsSchema } from "../../modules/tools/ls/pi/ls.ts";

/**
 * Per-tool option passthrough for built-in tool magnets. pi supplies the
 * host-dependent pieces (bash `operations` from shell discovery, SSH operations,
 * shellPath) so the harness assembler stays host-agnostic. bash `operations` is
 * REQUIRED (harness holds no host shell default), so `bash` must be provided for
 * a bash magnet to be built.
 */
export interface BuiltInToolOptions {
	bash?: BashExecuteOptions;
	read?: ReadToolOptions;
	edit?: EditToolOptions;
	write?: WriteToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	/** Descriptions the model sees. pi owns the canonical strings (see agent-session). */
	descriptions?: Partial<Record<"read" | "edit" | "write" | "find" | "ls", string | undefined>>;
}

export interface BuildSessionHcpOptions {
	/** Repo root (where harness/ + packages/ live). Defaults to process.cwd(). */
	repoRoot?: string;
	/** Packages root. Defaults to getHarnessPackagesRoot(repoRoot) = resolve(repoRoot,"packages"). */
	packagesRoot?: string;
	/** Working directory tools are bound to. Defaults to repoRoot. */
	cwd?: string;
	/** Loaded package overlay (package tools + capability overrides). Optional. */
	overlay?: PackageOverlay;
	/**
	 * A pre-assembled package HCP (from a prior `assemblePackageToolMagnets`
	 * call). Mutually exclusive with `overlay`: pass this when the caller has
	 * ALREADY assembled the overlay (e.g. to keep a single MCP-spawning pass with
	 * its own progress reporting) and only needs default capabilities + built-in
	 * tools layered on. When both are set, `packageHcp` wins and `overlay` is
	 * ignored (no re-assembly).
	 */
	packageHcp?: HcpClient;
	/** Include built-in tool magnets. Default true. */
	includeBuiltInTools?: boolean;
	/** Include default capability sources. Default true. */
	includeBuiltInCapabilities?: boolean;
	/** Per-tool options (bash operations required to build a bash magnet). */
	toolOptions?: BuiltInToolOptions;
}

export interface BuildSessionHcpResult {
	hcp: HcpClient;
	diagnostics: PackageDiagnostic[];
	/** Tool addresses registered (for diagnostics / tests). */
	toolAddresses: string[];
}

/**
 * Phase 0 — the unified session assembler.
 *
 * Produces ONE HcpClient (INV-2) that registers, through the single chain
 * LLM → HcpClient → HcpServer → HcpMagnet → harness source:
 *   - built-in tool magnets (read/bash/edit/write/grep/find/ls)
 *   - default capability sources (compaction/context/hook/memory/policy/
 *     prompt-template/runtime/sandbox)
 *   - package overlay tools + capability overrides (when an overlay is passed)
 *
 * This is the merge of Runtime A's `buildDefaultCapabilityHcp` (capabilities
 * only) and Runtime B's `assemblePackageToolMagnets` (package tools + overlay
 * capabilities). `packagesRoot` is derived with `getHarnessPackagesRoot` — the
 * SAME helper the overlay uses — so Runtime A's `packagesRoot: cwd` divergence
 * cannot recur.
 *
 * Precedence: a package-overlay capability override wins over the default source
 * for the same address (registered first; defaults only fill unregistered slots).
 */
export async function buildSessionHcp(options: BuildSessionHcpOptions = {}): Promise<BuildSessionHcpResult> {
	const repoRoot = options.repoRoot ?? process.cwd();
	const packagesRoot = options.packagesRoot ?? getHarnessPackagesRoot(repoRoot);
	const cwd = options.cwd ?? repoRoot;
	const includeBuiltInTools = options.includeBuiltInTools !== false;
	const includeBuiltInCapabilities = options.includeBuiltInCapabilities !== false;
	const diagnostics: PackageDiagnostic[] = [];

	const hcp = new HcpClient();
	const toolAddresses: string[] = [];

	// 1. Built-in tool magnets → ONE ModuleHcpServer("tools").
	if (includeBuiltInTools) {
		const magnets = buildBuiltInToolMagnets(cwd, options.toolOptions ?? {});
		const registered = hcp.registerModule(buildToolsModule(magnets));
		toolAddresses.push(...registered);
	}

	// 2. Package overlay (tools + capability overrides) — registered BEFORE
	//    defaults so an override wins the slot. A pre-assembled `packageHcp` is
	//    preferred over `overlay` to avoid a second MCP-spawning assembly pass.
	if (options.packageHcp) {
		copyRegistrations(options.packageHcp, hcp, { skipExisting: true, collectTools: toolAddresses });
	} else if (options.overlay) {
		const assembly = await assemblePackageToolMagnets(options.overlay);
		diagnostics.push(...assembly.diagnostics);
		copyRegistrations(assembly.hcp, hcp, { skipExisting: true, collectTools: toolAddresses });
	}

	// 3. Default capability sources — fill only slots not already provided by an
	//    overlay override.
	if (includeBuiltInCapabilities) {
		const capabilityResult = await buildDefaultCapabilityHcp({ repoRoot, packagesRoot });
		for (const d of capabilityResult.diagnostics) {
			diagnostics.push({ type: "error", code: d.code, message: d.message });
		}
		copyRegistrations(capabilityResult.hcp, hcp, { skipExisting: true });
	}

	return { hcp, diagnostics, toolAddresses };
}

/**
 * Build the `tools` ModuleHcpServer from a set of built-in tool magnets. The
 * in-module selector is the tool name (the suffix of the magnet's `tool:<name>`
 * address). Shared by `buildSessionHcp` and pi's per-runtime tool rebuild so
 * both produce an identical module (no dual registration paths).
 */
export function buildToolsModule(magnets: HcpMagnet[]): ModuleHcpServer {
	const slots = new Map<string, HcpMagnet>();
	for (const magnet of magnets) {
		const server = magnet.toHcpServer?.();
		if (!server) continue;
		const target = server.describe().target; // "tool:read"
		const selector = target.split(":")[1]; // "read"
		if (!selector) {
			throw new Error(`buildToolsModule: built-in tool target "${target}" has no selector`);
		}
		slots.set(selector, magnet);
	}
	return new ModuleHcpServer("tools", slots);
}

/**
 * Build native tool magnets for the 7 built-in tools (read, bash, edit, write,
 * grep, find, ls). This is exported so pi's agent-session can build magnets with
 * per-runtime options (SSH operations, shell path, auto-resize) and register them
 * into the session HCP at the right lifecycle point.
 *
 * @param cwd - working directory passed to each tool's createExecute
 * @param opts - per-tool options (SSH ops, shell path, descriptions, etc.)
 * @returns array of NativeToolMagnets ready for HCP registration
 */
export function buildBuiltInToolMagnets(cwd: string, opts: BuiltInToolOptions): HcpMagnet[] {
	const magnets: HcpMagnet[] = [];
	const desc = opts.descriptions ?? {};

	// bash requires host operations; skip if not supplied (harness has no default).
	if (opts.bash) {
		const bashOptions = opts.bash;
		magnets.push(
			new NativeToolMagnet(
				{
					name: "bash",
					description: BASH_TOOL_DESCRIPTION,
					parameters: bashSchema,
					createExecute: (boundCwd) => createBashExecute(boundCwd, bashOptions),
					renderKind: "shell-output",
				},
				cwd,
			),
		);
	}

	magnets.push(
		new NativeToolMagnet(
			{
				name: "read",
				description: desc.read ?? "Read the contents of a file (with optional line offset/limit).",
				parameters: readSchema,
				createExecute: (boundCwd) => createReadExecute(boundCwd, opts.read),
				renderKind: "file-content",
			},
			cwd,
		),
		new NativeToolMagnet(
			{
				name: "edit",
				description: desc.edit ?? "Apply one or more targeted text replacements to a file.",
				parameters: editSchema,
				createExecute: (boundCwd) => createEditExecute(boundCwd, opts.edit),
				renderKind: "text-edit",
			},
			cwd,
		),
		new NativeToolMagnet(
			{
				name: "write",
				description: desc.write ?? "Write content to a file, creating parent directories as needed.",
				parameters: writeSchema,
				createExecute: (boundCwd) => createWriteExecute(boundCwd, opts.write),
				renderKind: "file-write",
			},
			cwd,
		),
		new NativeToolMagnet(
			{
				name: "grep",
				description: GREP_DESCRIPTION,
				parameters: grepSchema,
				createExecute: (boundCwd) => createGrepExecute(boundCwd, opts.grep),
				renderKind: "pattern-search",
			},
			cwd,
		),
		new NativeToolMagnet(
			{
				name: "find",
				description: desc.find ?? "Find files matching a glob pattern.",
				parameters: findSchema,
				createExecute: (boundCwd) => createFindExecute(boundCwd, opts.find),
				renderKind: "file-search",
			},
			cwd,
		),
		new NativeToolMagnet(
			{
				name: "ls",
				description: desc.ls ?? "List directory entries.",
				parameters: lsSchema,
				createExecute: (boundCwd) => createLsExecute(boundCwd, opts.ls),
				renderKind: "directory-list",
			},
			cwd,
		),
	);

	return magnets;
}

/**
 * Merge a transient sub-assembly HCP into the single consumption HCP. Modules
 * are copied as modules (preserving Model B folder ownership); standalone leaf
 * servers (package tools, process magnets) are copied as leaves. `skipExisting`
 * preserves precedence: an address already resolvable in `into` is not overwritten.
 */
function copyRegistrations(
	from: HcpClient,
	into: HcpClient,
	options: { skipExisting?: boolean; collectTools?: string[] } = {},
): void {
	const collect = (address: string) => {
		if (options.collectTools && address.startsWith("tool:")) options.collectTools.push(address);
	};

	// Module-owned registrations: copy each module (its slots carry their addresses).
	for (const module of from.moduleServers()) {
		const slotAddrs = module.slotAddresses();
		// If skipExisting and every slot address already resolves, skip the module.
		if (options.skipExisting && slotAddrs.length > 0 && slotAddrs.every(({ address }) => into.resolve(address))) {
			continue;
		}
		into.registerModule(module);
		for (const { address } of slotAddrs) collect(address);
	}

	// Standalone leaf registrations (package tools, process magnets).
	for (const { address, server } of from.standaloneEntries()) {
		if (options.skipExisting && into.resolve(address)) continue;
		into.registerServer(address, server);
		collect(address);
	}
}
