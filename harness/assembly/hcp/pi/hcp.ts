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

	/** All registered prefixes (for diagnostics / listing). */
	prefixes(): string[] {
		return [...this.byPrefix.keys()];
	}

	/** Dispatch a call to its resolved target. Throws if none is registered. */
	async dispatch(call: HcpCall): Promise<unknown> {
		const target = this.resolve(call.target);
		if (!target) {
			throw new Error(`HCP: no target registered for "${call.target}"`);
		}
		return target.call(call);
	}
}
