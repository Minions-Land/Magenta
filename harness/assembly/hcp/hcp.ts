/**
 * HCP — the Harness Control Protocol.
 *
 * HCP is the management / assembly layer, NOT the agent loop's hot path
 * (see spec §1/§5). The loop calls `tool.execute()` directly, in-process; it
 * never wraps a tool call into an HCP message. HCP exists purely to discover,
 * configure, and manage components during assembly. Dispatch here is in-process
 * only — there is no transport, no serialization boundary.
 */

/**
 * Address prefix under which capability slots register. A capability slot named
 * `compaction` is reachable at `capability:compaction`; a named slot such as
 * `runtime:process` is reachable at `capability:runtime:process`. {@link
 * HcpRegistry.resolveCapability} builds this address from the slot name so
 * consumers never spell out the convention (or a source).
 */
export const capabilityPrefix = "capability";

/**
 * Ambient context threaded through an HCP call (assembly-time concerns such as
 * the working directory or a correlation id). Intentionally open-ended.
 */
export interface HcpContext {
	/** Working directory the call should be resolved against, if relevant. */
	cwd?: string;
	/** Optional correlation id for tracing an assembly operation. */
	requestId?: string;
	[key: string]: unknown;
}

/**
 * A single management call. `target` is a URI-like address (for example
 * `"tool:read"` or `"native:tool/read"`); the {@link HcpRegistry} resolves it by
 * prefix to a registered {@link HcpTarget}.
 */
export interface HcpCall {
	/** URI-like target address. The portion before the first `:` is the prefix. */
	target: string;
	/** Operation to invoke on the target (for example `"describe"` or `"call"`). */
	op: string;
	/** Operation input payload. */
	input?: unknown;
	/** Ambient assembly context. */
	context?: HcpContext;
}

/** A component endpoint reachable over HCP. */
export interface HcpTarget {
	/** Stable, machine-readable description of this target. */
	describe(): HcpTargetDescription;
	/** Handle a management call dispatched to this target. */
	call(call: HcpCall): Promise<unknown> | unknown;
	/**
	 * Assembly-time typed handoff: the selected source's in-process implementation
	 * for this capability slot. HCP is the resolver — a consumer asks for a
	 * capability by name and receives this instance, never knowing which source
	 * supplied it. Absent for pure management / inspect-only targets (a tool
	 * target returns its `AgentTool`; a compaction target returns its provider;
	 * an inspect-only target returns nothing). Once resolved, the instance is
	 * called directly on the hot path — HCP does not sit in that call.
	 */
	instance?<T = unknown>(): T | undefined;
}

/** Self-description returned by {@link HcpTarget.describe}. */
export interface HcpTargetDescription {
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
 * In-process registry of {@link HcpTarget}s, resolved by target prefix.
 *
 * The prefix is the substring before the first `:` in a target address. A target
 * registered under prefix `tool` handles every call whose `target` begins with
 * `tool:` unless a more specific exact-match target is registered.
 */
export class HcpRegistry {
	private readonly byPrefix = new Map<string, HcpTarget>();
	private readonly byExact = new Map<string, HcpTarget>();

	/** Register a target under a prefix (for example `"tool"`). */
	register(prefix: string, target: HcpTarget): this {
		this.byPrefix.set(prefix, target);
		return this;
	}

	/** Register a target under an exact address (for example `"tool:read"`). */
	registerExact(address: string, target: HcpTarget): this {
		this.byExact.set(address, target);
		return this;
	}

	/** Resolve the target responsible for an address, or `undefined`. */
	resolve(address: string): HcpTarget | undefined {
		const exact = this.byExact.get(address);
		if (exact) return exact;
		const prefix = address.split(":", 1)[0];
		return this.byPrefix.get(prefix);
	}

	/**
	 * Resolve a capability by its slot name (for example `"compaction"` or
	 * `"runtime:process"`) to the selected source's typed instance.
	 *
	 * This is the one place source selection is consumed: a consumer passes only
	 * the capability name and gets back the implementation the assembly layer
	 * chose, with no knowledge of which source (`pi`, `magenta`, …) supplied it.
	 * The slot name maps to the target address `capability:<name>`; a bare
	 * `<name>` address is also accepted as a fallback. Returns `undefined` when no
	 * target is registered for the name or the target exposes no instance
	 * (inspect-only / management-only targets).
	 */
	resolveCapability<T>(name: string): T | undefined {
		const target = this.resolve(`${capabilityPrefix}:${name}`) ?? this.resolve(name);
		return target?.instance?.<T>();
	}

	/** All registered prefixes (for diagnostics / listing). */
	prefixes(): string[] {
		return [...this.byPrefix.keys()];
	}

	/** All exact target addresses (for diagnostics / listing). */
	addresses(): string[] {
		return [...this.byExact.keys()];
	}

	/** Describe all exact and prefix targets currently registered. */
	describeAll(): HcpTargetDescription[] {
		const described = new Map<string, HcpTargetDescription>();
		for (const [address, target] of this.byExact) {
			described.set(address, target.describe());
		}
		for (const [prefix, target] of this.byPrefix) {
			described.set(`${prefix}:*`, target.describe());
		}
		return [...described.values()];
	}

	/** Dispatch a call to its resolved target. Throws if none is registered. */
	async dispatch(call: HcpCall): Promise<unknown> {
		if (call.target === "hcp:registry") {
			switch (call.op) {
				case "list":
				case "discover":
					return this.describeAll();
				case "prefixes":
					return this.prefixes();
				case "addresses":
					return this.addresses();
				default:
					throw new Error(`HCP registry: unsupported op "${call.op}"`);
			}
		}
		const target = this.resolve(call.target);
		if (!target) {
			throw new Error(`HCP: no target registered for "${call.target}"`);
		}
		return target.call(call);
	}
}
