import {
	capabilityPrefix,
	type HcpRequest,
	type HcpServer,
	type HcpServerDescription,
} from "../hcp-contract/hcp-server.ts";

/**
 * HcpClient — the global, single router of the HCP layer (spec §2, §10.1).
 *
 * A consumer asks for something by name (`"memory"`, `"bash"`,
 * `"system-prompt"`) and the client resolves that name to the selected source's
 * endpoint. This is the ONE place source selection is consumed; there is no
 * second selection registry. The server contracts it routes over live in
 * `hcp-contract/`; the magnet framework that produces those servers lives in
 * `hcp-magnet/`; the assembly orchestration that populates a client lives in
 * `hcp-client/assembly/`.
 *
 * In-process registry of {@link HcpServer}s, resolved by target prefix. The
 * prefix is the substring before the first `:` in a target address. A target
 * registered under prefix `tool` handles every call whose `target` begins with
 * `tool:` unless a more specific exact-match target is registered.
 */
export class HcpClient {
	private readonly byPrefix = new Map<string, HcpServer>();
	private readonly byExact = new Map<string, HcpServer>();

	/** Register a target under a prefix (for example `"tool"`). */
	register(prefix: string, target: HcpServer): this {
		this.byPrefix.set(prefix, target);
		return this;
	}

	/** Register a target under an exact address (for example `"tool:read"`). */
	registerExact(address: string, target: HcpServer): this {
		this.byExact.set(address, target);
		return this;
	}

	/** Resolve the target responsible for an address, or `undefined`. */
	resolve(address: string): HcpServer | undefined {
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
	describeAll(): HcpServerDescription[] {
		const described = new Map<string, HcpServerDescription>();
		for (const [address, target] of this.byExact) {
			described.set(address, target.describe());
		}
		for (const [prefix, target] of this.byPrefix) {
			described.set(`${prefix}:*`, target.describe());
		}
		return [...described.values()];
	}

	/** Dispatch a call to its resolved target. Throws if none is registered. */
	async dispatch(call: HcpRequest): Promise<unknown> {
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
