import type { CapabilityFactoryContext } from "./capability.ts";

/**
 * A source-owned capability descriptor (spec §8).
 *
 * Each capability source (`compaction/pi`, `memory/magenta`, ...) declares ONE
 * of these in its own folder (`<module>/<source>/magnet.ts`) and imports its
 * provider via a LITERAL sibling import, so tsc's extension rewrite keeps it
 * loadable in both source (`.ts`) and built (`dist/.js`) form. This replaces the
 * central `BUILTIN_CAPABILITY_BUILDERS` table: the build logic moves next to the
 * implementation it builds, and the only thing that stays central is a dumb
 * aggregation barrel (`sources.ts`) that re-exports these descriptors with NO
 * selection logic of its own.
 */
export interface CapabilitySourceMagnet<T = unknown> {
	/** Capability kind, e.g. `"compaction"`, `"runtime"`. */
	kind: string;
	/**
	 * Component name within the kind. Defaults to `kind` for single-component
	 * capabilities; multi-component families (e.g. runtime `process` vs
	 * `script-runtimes`) set it explicitly so their slots do not collide.
	 */
	name?: string;
	/** The source that supplies this implementation, e.g. `"pi"`, `"magenta"`. */
	source: string;
	/**
	 * Whether this source is the default for its slot when no package overlay
	 * selects one. Exactly one registered source per slot should set this; the
	 * default map is DERIVED from these flags rather than hand-maintained.
	 */
	isDefault?: boolean;
	/**
	 * For a source whose single builder serves several named slots (e.g. the
	 * magenta runtime builder serves both `runtime:process` and
	 * `runtime:script-runtimes`, dispatching on `context.name`), the extra slot
	 * names it is the default for, beyond {@link name}. Each becomes a
	 * `capabilitySlotName(kind, n)` entry in the derived default map.
	 */
	defaultSlotNames?: readonly string[];
	/**
	 * Node attribute (spec §9): may this slot's source selection change
	 * mid-session? Stateful capabilities (memory, context, policy, runtime,
	 * sandbox, ...) are frozen after assembly and MUST stay `false`/unset. Tools
	 * and skills, which can come and go with Tool Search deferral, are the
	 * hot-swappable ones. Capability magnets default to NOT hot-swappable, so a
	 * source that omits this is safely frozen. This is a per-node boolean and is
	 * distinct from `bundledWith`/`bundles` (the selection-graph EDGES, modeled
	 * separately in the package overlay).
	 */
	hotSwappable?: boolean;
	/** Build the source-selected, in-process implementation instance. */
	build(context: CapabilityFactoryContext): T | Promise<T>;
}
