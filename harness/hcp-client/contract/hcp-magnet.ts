import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CapabilityFactoryContext, HcpServer } from "./hcp-server.ts";

/**
 * HCP magnet contracts — the HcpMagnet role's shapes (spec §2, §8).
 *
 * Pure interfaces only: the concrete magnet framework (native / process /
 * python / hcp-process / universal transports) lives in `hcp-magnet/`, and the
 * per-source bindings live in each module's `<source>/magnet.ts`. This module
 * is the shared contract all of them implement.
 */

/**
 * A resolved non-tool capability binding produced by a magnet.
 *
 * Where {@link HcpMagnet.toTool} yields an LLM-facing tool for the loop hot path,
 * {@link HcpMagnet.toCapability} yields the in-process implementation that a
 * harness consumer (loop, session, hooks, ...) injects and calls directly.
 * The `instance` is the source-selected implementation object; the assembly
 * layer resolves *which* source to load, so the LLM never perceives the source.
 */
export interface CapabilityBinding<T = unknown> {
	/** Capability kind, e.g. `"compaction"`, `"memory"`. */
	kind: string;
	/** Component name within the kind, e.g. `"compaction"`, `"session-grounding"`. */
	name: string;
	/** The selected source that supplied this implementation, e.g. `"pi"`, `"magenta"`. */
	source: string;
	/** The source-selected implementation object, injected into consumers at assembly time. */
	instance: T;
}

/**
 * How a {@link HcpResource}'s content combines with other resources of the same
 * slot. Mirrors the two semantics already present in code for system-prompt
 * (spec §5): `replace` overrides the base (last-writer-wins, as consumed via
 * `.at(-1)` in the pi resource-loader) and `append` layers on top.
 */
export type ResourceMergeMode = "replace" | "append";

/**
 * A resolved Resource binding produced by a magnet (spec §5, the primitive HCP
 * adds to the Tool/Capability pair). A Resource is context **data** injected
 * into the model's context and *referenced* rather than *called* — e.g. a
 * package's `SYSTEM.md` system-prompt content. Unlike a {@link CapabilityBinding}
 * (a live in-process code provider) a Resource carries inert content plus the
 * location it was loaded from, so the resource layer can inject or override it.
 *
 * This is why the AutOmicScience regression (§5.1) was a category error: a
 * content-only `system-prompt` is a Resource, not a Capability, and must never
 * be routed through code-builder resolution.
 */
export interface HcpResource {
	/** Resource kind, e.g. `"system-prompt"`, `"prompt-template"`. */
	kind: string;
	/** Component name within the kind. */
	name: string;
	/** The selected source that supplied this content, e.g. `"pi"`, `"AutOmicScience"`. */
	source: string;
	/** How this resource combines with others in the same slot. */
	mergeMode: ResourceMergeMode;
	/** Absolute path the content was (or will be) loaded from, when file-backed. */
	contentPath?: string;
	/** Inline content, when the resource carries data directly rather than a path. */
	content?: string;
}

/**
 * A HcpMagnet is a connector that adapts one kind of implementation (native TS
 * today; MCP / API / process later) into the shapes the harness assembly layer
 * consumes: a loop-ready {@link AgentTool} (LLM hot path), a non-tool
 * {@link CapabilityBinding} (in-process capability the loop/session injects),
 * a {@link HcpResource} (injected context data), and/or an {@link HcpServer}
 * for management. Magnets run at assembly time only — they are how concrete
 * implementations get "attracted" into the harness regardless of source.
 *
 * Invariant: a magnet produces at most one of {@link HcpMagnet.toTool} /
 * {@link HcpMagnet.toCapability} / {@link HcpMagnet.toResource}. A tool never
 * lands on the capability map, a capability never leaks onto the LLM tool hot
 * path, and content-only resources never route through code-builder resolution.
 */
export interface HcpMagnet {
	/** Discriminator for the kind of implementation this magnet connects (for example `"native"`). */
	kind: string;
	/** Produce a loop-ready tool, if this magnet yields one. */
	toTool?(): AgentTool;
	/** Produce a source-selected non-tool capability binding, if this magnet yields one. */
	toCapability?(): CapabilityBinding;
	/** Produce a source-selected injected-context resource, if this magnet yields one. */
	toResource?(): HcpResource;
	/** Produce a management endpoint, if this magnet exposes one over HCP. */
	toHcpServer?(): HcpServer;
}

/**
 * A source-owned capability descriptor (spec §8).
 *
 * Each capability source (`compaction/pi`, `memory/magenta`, ...) declares ONE
 * of these in its own folder (`<module>/<source>/magnet.ts`) and imports its
 * provider via a LITERAL sibling import, so tsc's extension rewrite keeps it
 * loadable in both source (`.ts`) and built (`dist/.js`) form. This replaces the
 * central `BUILTIN_CAPABILITY_BUILDERS` table: the build logic moves next to the
 * implementation it builds, and the only thing that stays central is a dumb
 * aggregation barrel (`hcp-client/assembly/sources.ts`) that re-exports these
 * descriptors with NO selection logic of its own.
 */
export interface CapabilitySourceMagnet<T = unknown> {
	/**
	 * Module folder this capability belongs to (e.g. "compaction", "hooks",
	 * "runtime"). This is the module-realignment Model B orthogonal axis: module
	 * folder is distinct from capability `kind`, though they often match. The
	 * discrepancies (kind="hook" → module="hooks", kind="prompt-template" →
	 * module="prompt-templates") make this field necessary.
	 */
	module: string;
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
