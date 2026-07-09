/**
 * HCP server contract — the HcpServer role's shape (spec §2).
 *
 * HCP is the management / assembly layer, NOT the agent loop's hot path
 * (see spec §1/§5). The loop calls `tool.execute()` directly, in-process; it
 * never wraps a tool call into an HCP message. HCP exists purely to discover,
 * configure, and manage components during assembly. Dispatch here is in-process
 * only — there is no transport, no serialization boundary.
 *
 * This module holds the pure server-side contracts shared by all three HCP
 * roles (HcpClient resolves them, modules implement them, HcpMagnet produces
 * them). The HcpClient implementation lives in `hcp-client/hcp-client.ts`; the
 * HcpMagnet contracts live in `hcp-HcpMagnetTypes.ts`.
 */

/**
 * Address prefix under which capability slots register. A capability slot named
 * `compaction` is reachable at `capability:compaction`; a named slot such as
 * `runtime:process` is reachable at `capability:runtime:process`. The
 * `HcpClient.resolveCapability` method builds this address from the slot name so
 * consumers never spell out the convention (or a source).
 *
 * Naming: HcpClientcapabilityprefix follows the entity tree rule — no
 * HcpClientCapability entity exists, so 'capability' and 'prefix' stay lowercase.
 */
export const HcpClientcapabilityprefix = "capability";

/**
 * Ambient context threaded through an HCP call (assembly-time concerns such as
 * the working directory or a correlation id). Intentionally open-ended.
 */
export interface HcpServerContext {
	/** Working directory the call should be resolved against, if relevant. */
	cwd?: string;
	/** Optional correlation id for tracing an assembly operation. */
	requestId?: string;
	[key: string]: unknown;
}

/**
 * A single management call. `target` is a URI-like address (for example
 * `"tool:read"` or `"native:tool/read"`); the `HcpClient` resolves it by
 * prefix to a registered {@link HcpServer}.
 */
export interface HcpServerRequest {
	/** URI-like target address. The portion before the first `:` is the prefix. */
	target: string;
	/** Operation to invoke on the target (for example `"describe"` or `"call"`). */
	op: string;
	/** Operation input payload. */
	input?: unknown;
	/** Ambient assembly context. */
	context?: HcpServerContext;
}

/**
 * The result of handling an {@link HcpServerRequest}. Today HCP dispatch is in-process
 * with no serialization boundary (spec §1/§5), so a response is simply the
 * operation's return value. This alias names the request/response pair now so
 * the vocabulary is stable; when §3's protocol envelope lands, this becomes a
 * structured result type without renaming call sites.
 */
export type HcpServerResponse<T = unknown> = T;

/** A component endpoint reachable over HCP. */
export interface HcpServer {
	/** Stable, machine-readable description of this target. */
	describe(): HcpServerDescription;
	/** Handle a management call dispatched to this target. */
	call(call: HcpServerRequest): Promise<unknown> | unknown;
	/**
	 * Assembly-time typed handoff: the selected source's in-process implementation
	 * for this capability slot. HCP is the resolver — a consumer asks for a
	 * capability by name and receives this instance, never knowing which source
	 * supplied it. Absent for pure management / inspect-only targets (a tool
	 * target returns its `AgentTool`; a compaction target returns its provider;
	 * an inspect-only target returns nothing). Once resolved, the instance is
	 * called directly on the hot path — HCP does not sit in that call.
	 *
	 * The optional `selector` disambiguates WHICH product to hand back when a
	 * single server owns several addressable slots (a `ModuleHcpServer` for the
	 * `tools` module routes `selector="read"` vs `"bash"`; a `runtime` module
	 * routes `"process"` vs `"script-runtimes"`). Single-product servers ignore
	 * it, so widening is purely additive — no existing zero-arg caller changes.
	 */
	instance?<T = unknown>(selector?: string): T | undefined;
}

/** Self-description returned by {@link HcpServer.describe}. */
export interface HcpServerDescription {
	/** The target address this endpoint answers on. */
	target: string;
	/** Component kind (for example `"tool"`). */
	kind: string;
	/** Operations this target supports. */
	ops: string[];
	/** Optional human-readable summary. */
	description?: string;
	/** Optional component metadata for selectors and management UIs. */
	metadata?: Record<string, unknown>;
}

/**
 * Context passed to a capability factory at assembly time. Mirrors the
 * tool-magnet context so a capability implementation can locate its own module
 * tree, sibling components, and the repo root if it needs them.
 *
 * Lives in the contract module because {@link HcpMagnet}'s source descriptor
 * (`CapabilitySourceMagnet.build`) depends on it; keeping it here avoids a
 * contract → assembly back-dependency.
 */
export interface HcpMagnetBuildContext {
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
