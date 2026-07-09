import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext, HcpServer } from "./HcpServerTypes.ts";

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
export interface HcpMagnetBinding<T = unknown> {
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
 * How a {@link HcpMagnetResource}'s content combines with other resources of the same
 * slot. Mirrors the two semantics already present in code for system-prompt
 * (spec §5): `replace` overrides the base (last-writer-wins, as consumed via
 * `.at(-1)` in the pi resource-loader) and `append` layers on top.
 */
export type HcpMagnetResourceMergeMode = "replace" | "append";

/**
 * A resolved Resource binding produced by a magnet (spec §5, the primitive HCP
 * adds to the Tool/Capability pair). A Resource is context **data** injected
 * into the model's context and *referenced* rather than *called* — e.g. a
 * package's `SYSTEM.md` system-prompt content. Unlike a {@link HcpMagnetBinding}
 * (a live in-process code provider) a Resource carries inert content plus the
 * location it was loaded from, so the resource layer can inject or override it.
 *
 * This is why the AutOmicScience regression (§5.1) was a category error: a
 * content-only `system-prompt` is a Resource, not a Capability, and must never
 * be routed through code-builder resolution.
 */
export interface HcpMagnetResource {
	/** Resource kind, e.g. `"system-prompt"`, `"prompt-template"`. */
	kind: string;
	/** Component name within the kind. */
	name: string;
	/** The selected source that supplied this content, e.g. `"pi"`, `"AutOmicScience"`. */
	source: string;
	/** How this resource combines with others in the same slot. */
	mergeMode: HcpMagnetResourceMergeMode;
	/** Absolute path the content was (or will be) loaded from, when file-backed. */
	contentPath?: string;
	/** Inline content, when the resource carries data directly rather than a path. */
	content?: string;
}

/**
 * A HcpMagnet is a connector that adapts one kind of implementation (native TS
 * today; MCP / API / process later) into the shapes the harness assembly layer
 * consumes: a loop-ready {@link AgentTool} (LLM hot path), a non-tool
 * {@link HcpMagnetBinding} (in-process capability the loop/session injects),
 * a {@link HcpMagnetResource} (injected context data), and/or an {@link HcpServer}
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
	toCapability?(): HcpMagnetBinding;
	/** Produce a source-selected injected-context resource, if this magnet yields one. */
	toResource?(): HcpMagnetResource;
	/** Produce a management endpoint, if this magnet exposes one over HCP. */
	toHcpServer?(): HcpServer;
}

/**
 * Class constructor signature for capability magnets (replaces CapabilitySourceMagnet).
 *
 * Each module's HcpMagnet.ts exports `class HcpMagnet extends CapabilityMagnet` with
 * static metadata properties and a constructor that takes HcpMagnetBuildContext.
 * This removes the two-step pattern (descriptor object + wrapper) in favor of
 * direct instantiation.
 */
export interface HcpMagnetClass {
	new (context: HcpMagnetBuildContext): HcpMagnet;
	readonly module: string;
	readonly kind: string;
	readonly slotName?: string;
	readonly source: string;
	readonly isDefault?: boolean;
	readonly hotSwappable?: boolean;
	readonly defaultSlotNames?: readonly string[];
}
