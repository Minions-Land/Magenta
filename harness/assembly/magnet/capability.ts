import { capabilityPrefix, HcpClient } from "../hcp/hcp.ts";
import { registerMagnetHcpServers } from "./hcp-registry.ts";
import type { HcpMagnet } from "./magnet.ts";
import { CAPABILITY_SOURCE_MAGNETS } from "./sources.ts";
import { CapabilityMagnet } from "./universal.ts";

/**
 * Context passed to a capability factory at assembly time. Mirrors the
 * tool-magnet context so a capability implementation can locate its own module
 * tree, sibling components, and the repo root if it needs them.
 */
export interface CapabilityFactoryContext {
	repoRoot: string;
	packagesRoot: string;
	/** Component kind being built (e.g. "runtime"). */
	kind: string;
	/** Component name being built (e.g. "process"). */
	name: string;
	/** Absolute path to the module's TOML descriptor (e.g. compaction/compaction.toml). */
	descriptorPath?: string;
	/** The selected source for this component (e.g. "pi", "magenta"). */
	source: string;
}

/**
 * Builds the source-selected, in-process implementation object for a capability.
 * The assembly layer picks one builder per capability by the component's
 * declared `source`; the builder returns the concrete implementation.
 */
export type CapabilityBuilder<T = unknown> = (context: CapabilityFactoryContext) => T | Promise<T>;

/** A `${kind}:${source}` → builder selection table. */
export type CapabilityBuilderTable = Record<string, CapabilityBuilder>;

function builderKey(kind: string, source: string): string {
	return `${kind}:${source}`;
}

const NAMED_CAPABILITY_KINDS = new Set<string>(["runtime"]);

export function capabilitySlotName(kind: string, name: string): string {
	return NAMED_CAPABILITY_KINDS.has(kind) ? `${kind}:${name}` : kind;
}

export function capabilityBindingKey(binding: { kind: string; name: string }): string {
	return capabilitySlotName(binding.kind, binding.name);
}

function parseCapabilitySlot(slot: string): { kind: string; name: string } {
	const [kind, ...nameParts] = slot.split(":");
	const parsedKind = kind ?? slot;
	return {
		kind: parsedKind,
		name: nameParts.length > 0 ? nameParts.join(":") : parsedKind,
	};
}

/**
 * Builder-table entries derived from the relocated source magnets (§8 barrel).
 * Every built-in capability source now lives in `<module>/<source>/magnet.ts`
 * and is collected by the dumb `sources.ts` barrel; there is no central builder
 * table left. The barrel makes no selection decisions, so it is not a second
 * selection registry (invariant §10.1).
 */
function buildersFromSourceMagnets(): CapabilityBuilderTable {
	const table: CapabilityBuilderTable = {};
	for (const magnet of CAPABILITY_SOURCE_MAGNETS) {
		table[builderKey(magnet.kind, magnet.source)] = (context) => magnet.build(context);
	}
	return table;
}

/** Default-source entries derived from relocated source magnets' `isDefault`. */
function defaultsFromSourceMagnets(): Record<string, string> {
	const defaults: Record<string, string> = {};
	for (const magnet of CAPABILITY_SOURCE_MAGNETS) {
		if (!magnet.isDefault) continue;
		const slotNames = [magnet.name ?? magnet.kind, ...(magnet.defaultSlotNames ?? [])];
		for (const slotName of slotNames) {
			defaults[capabilitySlotName(magnet.kind, slotName)] = magnet.source;
		}
	}
	return defaults;
}

/**
 * The built-in capability builder table, DERIVED entirely from the source
 * magnets in the `sources.ts` barrel (spec §8). The old central
 * `BUILTIN_CAPABILITY_BUILDERS` literal is fully dissolved: each source owns its
 * build logic next to its implementation. Consumers still receive one table via
 * this const; it just is no longer hand-maintained here.
 */
const BUILTIN_CAPABILITY_BUILDERS: CapabilityBuilderTable = buildersFromSourceMagnets();

/**
 * The default-source map, DERIVED from source magnets' `isDefault` declarations
 * (spec §8). Consumers resolve capabilities by name through HCP and never see a
 * source; the default they get is declared by each SOURCE (via `isDefault`) and
 * merely collected here — not decided by a hand-maintained central table.
 */
const DEFAULT_CAPABILITY_SOURCES: Record<string, string> = defaultsFromSourceMagnets();

/** The sources a table offers for a kind (for diagnostics / switchability). */
function sourcesForKind(table: CapabilityBuilderTable, kind: string): string[] {
	const prefix = `${kind}:`;
	return Object.keys(table)
		.filter((key) => key.startsWith(prefix))
		.map((key) => key.slice(prefix.length))
		.sort();
}

export interface CreateCapabilityMagnetComponent {
	kind: string;
	name: string;
	description?: string;
	/** Absolute path to the module TOML descriptor. */
	path?: string;
	/** Selected source (from the component TOML `source` field). */
	source: string;
}

export interface CreateCapabilityMagnetOptions {
	component: CreateCapabilityMagnetComponent;
	context: { repoRoot: string; packagesRoot: string };
	/**
	 * Override the capability selection table. Defaults to the one built-in
	 * table. Tests inject their own here instead of mutating global state, so
	 * there is no shared registry to reset between cases.
	 */
	builders?: CapabilityBuilderTable;
}

export type CapabilityMagnetDiagnosticCode =
	| "capability_source_missing"
	| "capability_factory_missing"
	| "capability_factory_failed";

export interface CapabilityMagnetDiagnostic {
	type: "error";
	code: CapabilityMagnetDiagnosticCode;
	message: string;
	kind: string;
	name: string;
	source?: string;
}

export interface CreateCapabilityMagnetResult {
	magnet?: HcpMagnet;
	diagnostics: CapabilityMagnetDiagnostic[];
}

/**
 * Resolve a non-tool component into a {@link CapabilityMagnet} by selecting the
 * factory for its declared `source`, building the implementation instance, and
 * wrapping it with the shared HCP management surface. The HCP target is
 * `${capabilityPrefix}:${kind}` (e.g. `capability:compaction`), so the
 * capability resolves by slot name via {@link HcpClient.resolveCapability}
 * without ever appearing on the LLM tool hot path.
 */
export async function createCapabilityMagnet(
	options: CreateCapabilityMagnetOptions,
): Promise<CreateCapabilityMagnetResult> {
	const { component, context } = options;
	const table = options.builders ?? BUILTIN_CAPABILITY_BUILDERS;
	const diagnostics: CapabilityMagnetDiagnostic[] = [];

	if (!component.source) {
		diagnostics.push({
			type: "error",
			code: "capability_source_missing",
			message: `Capability ${component.kind}:${component.name} declares no source.`,
			kind: component.kind,
			name: component.name,
		});
		return { diagnostics };
	}

	const builder = table[builderKey(component.kind, component.source)];
	if (!builder) {
		diagnostics.push({
			type: "error",
			code: "capability_factory_missing",
			message:
				`No capability implementation available for ${component.kind}:${component.source}. ` +
				`Available sources: [${sourcesForKind(table, component.kind).join(", ") || "none"}].`,
			kind: component.kind,
			name: component.name,
			source: component.source,
		});
		return { diagnostics };
	}

	let instance: unknown;
	try {
		instance = await builder({
			repoRoot: context.repoRoot,
			packagesRoot: context.packagesRoot,
			kind: component.kind,
			name: component.name,
			descriptorPath: component.path,
			source: component.source,
		});
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "capability_factory_failed",
			message: `Capability ${component.kind}:${component.source} builder threw: ${
				error instanceof Error ? error.message : String(error)
			}`,
			kind: component.kind,
			name: component.name,
			source: component.source,
		});
		return { diagnostics };
	}

	// Register under the capability address convention. Single-slot capabilities
	// use `capability:<kind>`; multi-instance capability families use
	// `capability:<kind>:<name>` so entries like runtime:process and
	// runtime:script-runtimes do not collide. The bare kind/name is deliberately
	// NOT the address — that namespace is for management targets; capabilities
	// live under the `capability:` prefix.
	const target = `${capabilityPrefix}:${capabilitySlotName(component.kind, component.name)}`;
	const magnet = new CapabilityMagnet({
		descriptor: {
			target,
			kind: component.kind,
			name: component.name,
			implementation: `capability:${component.source}`,
			description: component.description,
			metadata: { source: component.source },
		},
		source: component.source,
		instance,
	});

	return { magnet, diagnostics };
}

/**
 * Build an HCP registry pre-populated with the default-sourced implementation of
 * each capability kind in {@link DEFAULT_CAPABILITY_SOURCES}. This is the
 * source-agnostic default a consumer resolves against when no package overlay
 * selected a capability: the loop asks the returned registry for `"compaction"`
 * by name and gets the built-in implementation, without the loop ever naming a
 * source. Selection stays in the assembly layer where it belongs.
 *
 * Building is idempotent and cheap (one lazy import per kind); callers may cache
 * the result. Kinds whose builder is missing are skipped with a diagnostic so a
 * misconfigured table degrades to "capability unavailable" rather than throwing.
 */
export async function buildDefaultCapabilityHcp(
	context: { repoRoot: string; packagesRoot: string },
	options?: { builders?: CapabilityBuilderTable; defaults?: Record<string, string> },
): Promise<{ hcp: HcpClient; diagnostics: CapabilityMagnetDiagnostic[] }> {
	const builders = options?.builders ?? BUILTIN_CAPABILITY_BUILDERS;
	const defaults = options?.defaults ?? DEFAULT_CAPABILITY_SOURCES;
	const hcp = new HcpClient();
	const diagnostics: CapabilityMagnetDiagnostic[] = [];
	const magnets: HcpMagnet[] = [];

	for (const [slot, source] of Object.entries(defaults)) {
		const { kind, name } = parseCapabilitySlot(slot);
		const result = await createCapabilityMagnet({
			component: { kind, name, source },
			context,
			builders,
		});
		diagnostics.push(...result.diagnostics);
		if (result.magnet) magnets.push(result.magnet);
	}

	registerMagnetHcpServers(hcp, magnets);
	return { hcp, diagnostics };
}
