import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "./HcpServerTypes.ts";

/**
 * HCP magnet protocol data types (spec §2, §8).
 *
 * 按照规范§2："全仓无 interface"。此文件只包含协议数据类型（HcpMagnetBinding等），
 * 不包含角色接口。HcpMagnet 是裸 class，在各 modules/<m>/<s>/HcpMagnet.ts 中定义。
 *
 * The concrete magnet framework (native / process / python / hcp-process / universal
 * transports) lives in `hcp-magnet/`, and the per-source bindings live in each
 * module's `<source>/HcpMagnet.ts`. This module is the shared data types.
 */

/**
 * A resolved non-tool capability binding produced by a magnet.
 *
 * Where HcpMagnet.toTool yields an LLM-facing tool for the loop hot path,
 * HcpMagnet.toCapability yields the in-process implementation that a
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
 * How an HcpMagnetResource's content combines with other resources of the same
 * slot. Mirrors the two semantics already present in code for system-prompt
 * (spec §5): `replace` overrides the base (last-writer-wins, as consumed via
 * `.at(-1)` in the pi resource-loader) and `append` layers on top.
 */
export type HcpMagnetResourceMergeMode = "replace" | "append";

/**
 * A resolved Resource binding produced by a magnet (spec §5, the primitive HCP
 * adds to the Tool/Capability pair). A Resource is context **data** injected
 * into the model's context and *referenced* rather than *called* — e.g. a
 * package's `SYSTEM.md` system-prompt content. Unlike an HcpMagnetBinding
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
 * Class constructor signature for capability magnets.
 *
 * Each module's HcpMagnet.ts exports `class HcpMagnet` (裸 class，不继承任何基类) with
 * static metadata properties and a constructor that takes HcpMagnetBuildContext.
 *
 * 按照规范§2第112行：裸 class，不 implements、不 import 任何接口。
 */
export interface HcpMagnetClass {
	new (context: HcpMagnetBuildContext): {
		/** Discriminator for the kind of implementation this magnet connects (for example `"native"`). */
		kind: string;
		/** Produce a loop-ready tool, if this magnet yields one. */
		toTool?(): AgentTool;
		/** Produce a source-selected non-tool capability binding, if this magnet yields one. */
		toCapability?(): HcpMagnetBinding;
		/** Produce a source-selected injected-context resource, if this magnet yields one. */
		toResource?(): HcpMagnetResource;
		/** Produce a management endpoint, if this magnet exposes one over HCP. */
		toHcpServer?(): {
			describe(): import("./HcpServerTypes.ts").HcpServerDescription;
			call(call: import("./HcpServerTypes.ts").HcpServerRequest): Promise<unknown> | unknown;
			instance?<T = unknown>(selector?: string): T | undefined;
		};
	};
	readonly module: string;
	readonly kind: string;
	readonly slotName?: string;
	readonly source: string;
	readonly isDefault?: boolean;
	readonly hotSwappable?: boolean;
	readonly defaultSlotNames?: readonly string[];
}
