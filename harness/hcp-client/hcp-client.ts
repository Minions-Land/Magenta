import {
	capabilityPrefix,
	type HcpRequest,
	type HcpServer,
	type HcpServerDescription,
} from "../hcp-contract/hcp-server.ts";
import type { ModuleHcpServer } from "../hcp-magnet/module-server.ts";

/**
 * HcpClient — the global, single router of the HCP layer (spec §2, §10.1).
 *
 * A consumer asks for something by address (`"tool:read"`) or capability name
 * (`"compaction"`, `"runtime:process"`) and the client resolves it to the owning
 * module server, which routes to the selected source's implementation. This is
 * the ONE place source selection is consumed; there is no second selection
 * registry.
 *
 * Strict Model B resolution chain (NO facade objects, NO per-magnet server from
 * resolve()):
 *
 *   HcpClient → HcpServer(module) → HcpMagnet(source) → source impl
 *
 * `resolve(address)` returns the MODULE-LEVEL {@link ModuleHcpServer} that owns
 * the address. Consumers that want the implementation call
 * {@link resolveInstance} (or {@link resolveCapability}), which supplies the
 * in-module selector from the routing index so the caller never computes it.
 *
 * Storage:
 *  - byModule: the real per-module-folder servers (tools + capability modules).
 *  - addrToModule: thin `address → {module, selector}` routing pointers.
 *  - byPrefix: multi-endpoint provider servers (context://, runtime://) that own
 *    several sub-addresses under one scheme and dispatch them internally.
 *  - byAddress: leaf/package standalone servers (hcp-process, package tools) that
 *    are not part of the harness module-folder structure.
 */
export class HcpClient {
	private readonly byModule = new Map<string, ModuleHcpServer>();
	private readonly addrToModule = new Map<string, { module: string; selector: string }>();
	private readonly byPrefix = new Map<string, HcpServer>();
	private readonly byAddress = new Map<string, HcpServer>();

	/**
	 * Register a {@link ModuleHcpServer} and index its slot addresses. Replaces an
	 * existing module of the same name (enables pi's per-runtime tool rebuild).
	 * Returns the addresses registered (for diagnostics).
	 */
	registerModule(module: ModuleHcpServer): string[] {
		this.byModule.set(module.moduleName, module);
		const registered: string[] = [];
		for (const { address, selector } of module.slotAddresses()) {
			this.addrToModule.set(address, { module: module.moduleName, selector });
			registered.push(address);
		}
		return registered;
	}

	/**
	 * Register a standalone leaf server at an exact address (package tools,
	 * hcp-process magnets). Stores the magnet's own server directly. Replaces any
	 * prior registration (module-owned or standalone) at that address.
	 */
	registerServer(address: string, server: HcpServer): this {
		this.addrToModule.delete(address);
		this.byAddress.set(address, server);
		return this;
	}

	/** Register a multi-endpoint provider server under a scheme prefix (e.g. "context"). */
	register(prefix: string, server: HcpServer): this {
		this.byPrefix.set(prefix, server);
		return this;
	}

	/**
	 * Resolve an address to the MODULE-LEVEL {@link HcpServer} that owns it.
	 * Order: standalone leaf → module server → prefix provider. For a module-owned
	 * address this returns the {@link ModuleHcpServer}; call `.instance(selector)`
	 * on it (or use {@link resolveInstance} to have the selector supplied).
	 */
	resolve(address: string): HcpServer | undefined {
		const leaf = this.byAddress.get(address);
		if (leaf) return leaf;

		const route = this.addrToModule.get(address);
		if (route) {
			const module = this.byModule.get(route.module);
			if (module) return module;
		}

		const prefix = address.split(":", 1)[0];
		return this.byPrefix.get(prefix);
	}

	/**
	 * Resolve an address directly to the selected source's implementation, routing
	 * the in-module selector automatically. This is the one-call path consumers
	 * use instead of `resolve(address).instance(selector)`:
	 *
	 *   resolveInstance("tool:read")                  → tools module .instance("read")
	 *   resolveInstance("capability:compaction")      → compaction module .instance("compaction")
	 *   resolveInstance("capability:runtime:process") → runtime module .instance("runtime:process")
	 *
	 * For module-owned addresses the selector comes from the routing index (built
	 * at registration), so the caller never spells it out. Leaf/prefix servers are
	 * single-product and are asked for `.instance()` directly.
	 */
	resolveInstance<T>(address: string): T | undefined {
		const leaf = this.byAddress.get(address);
		if (leaf) return leaf.instance?.<T>();

		const route = this.addrToModule.get(address);
		if (route) {
			const module = this.byModule.get(route.module);
			return module?.instance?.<T>(route.selector);
		}

		const prefix = address.split(":", 1)[0];
		return this.byPrefix.get(prefix)?.instance?.<T>();
	}

	/**
	 * Resolve a capability by its slot name (for example `"compaction"` or
	 * `"runtime:process"`) to the selected source's typed instance. Sugar over
	 * {@link resolveInstance}: the slot name maps to the address
	 * `capability:<name>`, with a bare `<name>` address accepted as a fallback.
	 * Consumers pass only the capability name and never know which source supplied
	 * it. Returns `undefined` when nothing is registered or the target is
	 * inspect-only.
	 */
	resolveCapability<T>(name: string): T | undefined {
		return this.resolveInstance<T>(`${capabilityPrefix}:${name}`) ?? this.resolveInstance<T>(name);
	}

	/** Resolve a module server by its folder name (Model B direct access). */
	resolveModule(name: string): ModuleHcpServer | undefined {
		return this.byModule.get(name);
	}

	/** All registered module folder names. */
	modules(): string[] {
		return [...this.byModule.keys()];
	}

	/** The module servers themselves (for merging one HCP's modules into another). */
	moduleServers(): ModuleHcpServer[] {
		return [...this.byModule.values()];
	}

	/** Standalone (non-module) leaf addresses, paired with their server (for merge). */
	standaloneEntries(): Array<{ address: string; server: HcpServer }> {
		return [...this.byAddress].map(([address, server]) => ({ address, server }));
	}

	/**
	 * Describe the registered {@link ModuleHcpServer}s as first-class entities,
	 * each with its slot metadata. This is what a module-grouped management UI (the
	 * `/dock` Harness menu) renders, distinct from {@link describeAll}.
	 */
	describeModules(): HcpServerDescription[] {
		return [...this.byModule.values()].map((module) => module.describe());
	}

	/** All flat addresses currently resolvable (module-owned + standalone). */
	addresses(): string[] {
		return [...new Set([...this.addrToModule.keys(), ...this.byAddress.keys()])];
	}

	/**
	 * Describe all resolvable targets (module slots + standalone leaves + prefix
	 * providers). Module-owned addresses expand to each source magnet's own
	 * per-slot description. The menu filters by `target.startsWith("tool:")` /
	 * `"capability:"` for kind grouping, or uses {@link describeModules} for
	 * folder grouping.
	 */
	describeAll(): HcpServerDescription[] {
		const described = new Map<string, HcpServerDescription>();

		for (const module of this.byModule.values()) {
			for (const desc of module.describeSlots()) {
				described.set(desc.target, desc);
			}
		}
		for (const [address, server] of this.byAddress) {
			described.set(address, server.describe());
		}
		for (const [prefix, server] of this.byPrefix) {
			described.set(`${prefix}:*`, server.describe());
		}

		return [...described.values()];
	}

	/**
	 * Dispatch a management call to its resolved target. The `hcp:registry` target
	 * is introspection; every other target resolves to a module/leaf/prefix server.
	 */
	async dispatch(call: HcpRequest): Promise<unknown> {
		if (call.target === "hcp:registry") {
			switch (call.op) {
				case "list":
				case "discover":
					return this.describeAll();
				case "addresses":
					return this.addresses();
				case "modules":
					return this.modules();
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
