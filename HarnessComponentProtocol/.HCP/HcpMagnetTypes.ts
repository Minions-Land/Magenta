/**
 * HCP magnet protocol data types (spec §2, §8).
 *
 * 按照规范§2：全仓只使用 class 与 type。此文件只包含协议数据类型
 * （HcpMagnetBinding 等），不包含角色抽象。HcpMagnet 是裸 class，在各
 * <module>/<source>/HcpMagnet.ts 中定义。Transport plumbing lives in
 * `.HCP/transport/`; it does not form a Magnet subtype framework.
 */

/**
 * Context passed to a Magnet's static build entry point at assembly time. It lets a source
 * locate its module tree, sibling components, and the repository root.
 */
export type HcpMagnetBuildContext = {
	repoRoot: string;
	/** Host-owned cache root for durable, reconstructable component caches. */
	cacheRoot?: string;
	/** Resolve an already-selected capability dependency from the one session Client. */
	resolveCapability?<T>(name: string): T | undefined;
	/** Working directory bound to a tool product. Defaults to repoRoot. */
	cwd?: string;
	/** Component kind being built (e.g. "runtime"). */
	kind: string;
	/** Component name being built (e.g. "process"). */
	name: string;
	/** Absolute path to the module's TOML descriptor (e.g. compaction/compaction.toml). */
	descriptorPath?: string;
	/** The selected source for this component (e.g. "pi", "magenta"). */
	source: string;
	/** Source-owned constructor settings supplied by the host. */
	settings?: unknown;
	/** Optional model-facing description override supplied by the host. */
	description?: string;
	/** Whether this capability can be hot-swapped mid-session (spec §9). */
	hotSwappable?: boolean;
};

/**
 * A resolved non-tool capability binding produced by a magnet.
 *
 * Where HcpMagnet.toTool yields an LLM-facing tool for the loop hot path,
 * HcpMagnet.toCapability yields the in-process implementation that a
 * harness consumer (loop, session, hooks, ...) injects and calls directly.
 * The `instance` is the source-selected implementation object; the assembly
 * layer resolves *which* source to load, so the LLM never perceives the source.
 */
export type HcpMagnetBinding<T = unknown> = {
	/** Capability kind, e.g. `"compaction"`, `"memory"`. */
	kind: string;
	/** Component name within the kind, e.g. `"compaction"`, `"session-grounding"`. */
	name: string;
	/** The selected source that supplied this implementation, e.g. `"pi"`, `"magenta"`. */
	source: string;
	/** The source-selected implementation object, injected into consumers at assembly time. */
	instance: T;
};

/**
 * How an HcpMagnetResource's content combines with other resources of the same
 * slot. Mirrors the two semantics already present in code for system-prompt
 * (spec §5): `replace` overrides the base (last-writer-wins, as consumed via
 * `.at(-1)` in the pi resource-loader) and `append` layers on top.
 */
export type HcpMagnetResourceMergeMode = "replace" | "append";

/**
 * Host-supplied settings for a descriptor-backed Resource Source. The Source
 * class is always `descriptor`; `source` records the host-supplied owner id.
 */
export type HcpMagnetResourcebuildsettings = {
	name: string;
	source: string;
	mergeMode: HcpMagnetResourceMergeMode;
	contentPath?: string;
	content?: string;
	descriptorPath?: string;
	metadata?: Record<string, unknown>;
};

/**
 * A resolved Resource binding produced by a Magnet. Resource is the third
 * Magnet product beside Tool and Capability. It is context **data** injected
 * into the model's context and *referenced* rather than *called* — e.g. a
 * host source's `SYSTEM.md` system-prompt content. Unlike an HcpMagnetBinding
 * (a live in-process code provider) a Resource carries inert content plus the
 * location it was loaded from, so the resource layer can inject or override it.
 *
 * A content-only `system-prompt` is a Resource, not a Capability, and must
 * never be routed through code-builder resolution.
 */
export type HcpMagnetResource = {
	/** Resource kind, e.g. `"system-prompt"`, `"prompt-template"`. */
	kind: string;
	/** Component name within the kind. */
	name: string;
	/** The selected source that supplied this content, e.g. `"pi"`, `"external"`. */
	source: string;
	/** How this resource combines with others in the same slot. */
	mergeMode: HcpMagnetResourceMergeMode;
	/** Absolute path the content was (or will be) loaded from, when file-backed. */
	contentPath?: string;
	/** Inline content, when the resource carries data directly rather than a path. */
	content?: string;
	/** Host-owned provenance or loading details that do not affect HCP routing. */
	metadata?: Record<string, unknown>;
};
