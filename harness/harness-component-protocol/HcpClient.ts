import type { HcpMagnetClass } from "./HcpMagnetTypes.ts";
import {
	HcpClientcapabilityprefix,
	type HcpServerDescription,
	type HcpServerRequest,
} from "../harness-component-protocol/HcpServerTypes.ts";

/**
 * HcpServer 的结构化类型约束（规范§2：全仓无 interface，靠结构化类型）。
 * 任何具有这些方法的对象都可以作为 HcpServer 使用。
 */
type HcpServerShape = {
	describe(): HcpServerDescription;
	call(call: HcpServerRequest): Promise<unknown> | unknown;
	instance?<T = unknown>(selector?: string): T | undefined;
};

/**
 * HcpMagnet 的结构化类型约束。
 */
type HcpMagnetShape = {
	kind: string;
	toTool?(): unknown;
	toCapability?(): unknown;
	toResource?(): unknown;
	toHcpServer?(): HcpServerShape;
};

/**
 * Extract the name portion from an HCP target address.
 * Handles both "kind:name" and "kind://name" formats.
 * Examples:
 *   "hook:pre-send" → "pre-send"
 *   "hook://pre-tool" → "pre-tool"
 *   "context://workspace" → "workspace"
 */
export function targetName(target: string): string {
	// Handle "kind://name" format
	if (target.includes("://")) {
		const protocolEnd = target.indexOf("://");
		return target.slice(protocolEnd + 3);
	}
	// Handle "kind:name" format
	const colonIndex = target.indexOf(":");
	return colonIndex >= 0 ? target.slice(colonIndex + 1) : target;
}

/**
 * Internal module server implementation. A module server is the runtime embodiment
 * of one harness module folder (`tools`, `compaction`, `runtime`, …) AND is itself
 * an HcpServer that `HcpClient.resolve()` returns for any address the module
 * owns. This is strict Model B: the resolution chain is
 *
 *   HcpClient → HcpServer(this module) → HcpMagnet(source) → source impl
 *
 * The module owns the source magnets that folder contributes, keyed by an
 * in-module selector:
 *   - single-slot folder (`compaction`): one magnet, selector = capability slot
 *   - multi-slot folder (`tools`: read/bash/…; `runtime`: process +
 *     script-runtimes): one magnet per selector.
 *
 * There is NO per-address facade object. `resolve("tool:read")` returns THIS
 * server; the consumer then calls `.instance("read")` (or, via the client,
 * `resolveInstance("tool:read")`, which supplies the selector from the routing
 * index). A single-slot module accepts a bare `.instance()` and uses its lone
 * slot — a real routing rule, not a compatibility shim.
 */
class ModuleHcpServer implements HcpServerShape {
	readonly moduleName: string;
	private readonly slots: Map<string, HcpMagnetShape>;

	/**
	 * @param moduleName Module folder name (e.g. "tools", "compaction", "runtime").
	 * @param slots Map of in-module selector → magnet. For single-slot modules the
	 *              selector is the capability slot name ("compaction"); for
	 *              multi-slot modules it is the component name ("read", "bash",
	 *              "runtime:process").
	 */
	constructor(moduleName: string, slots: Map<string, HcpMagnetShape>) {
		this.moduleName = moduleName;
		this.slots = slots;
	}

	/** The selectors this module owns (for menu drill-down + tests). */
	selectors(): string[] {
		return [...this.slots.keys()];
	}

	/**
	 * The flat addresses this module owns, paired with their selector, so the
	 * HcpClient can build its `address → {module, selector}` routing index. The
	 * address is the magnet server's own `describe().target` ("tool:read",
	 * "capability:runtime:process"), which stays the stable, resolvable address.
	 */
	slotAddresses(): Array<{ address: string; selector: string }> {
		const out: Array<{ address: string; selector: string }> = [];
		for (const selector of this.slots.keys()) {
			const server = this.magnetServer(selector);
			if (!server) continue;
			out.push({ address: server.describe().target, selector });
		}
		return out;
	}

	/** Internal: the source magnet's own HcpServer for one selector. */
	private magnetServer(selector: string): HcpServerShape | undefined {
		const magnet = this.slots.get(selector);
		if (!magnet) return undefined;
		const server = magnet.toHcpServer?.();
		if (!server) {
			throw new Error(`ModuleHcpServer(${this.moduleName}): magnet "${selector}" has no toHcpServer()`);
		}
		return server;
	}

	/**
	 * Resolve the effective selector: an explicit selector when given, otherwise
	 * the sole slot for a single-slot module. Multi-slot modules with no selector
	 * return undefined (the caller must disambiguate).
	 */
	private effectiveSelector(selector?: string): string | undefined {
		if (selector !== undefined) return selector;
		if (this.slots.size === 1) return this.slots.keys().next().value as string;
		return undefined;
	}

	/**
	 * HcpServer.instance — route to the source magnet's implementation.
	 * - multi-slot module: selector REQUIRED; unknown/absent → undefined.
	 * - single-slot module: selector optional; when omitted, uses the sole slot.
	 */
	instance<T>(selector?: string): T | undefined {
		const eff = this.effectiveSelector(selector);
		if (eff === undefined) return undefined;
		return this.magnetServer(eff)?.instance?.<T>();
	}

	/**
	 * HcpServer.call — dispatch a management op. A module-level `describe` returns
	 * this module's aggregate description; any other op is routed to a slot's
	 * magnet server. The slot is taken from `call.input.selector` when present,
	 * otherwise the single-slot default applies.
	 */
	call(call: HcpServerRequest): Promise<unknown> | unknown {
		if (call.op === "describe" && !this.hasSelectorInput(call)) {
			return this.describe();
		}
		const selector = this.selectorFromCall(call);
		const eff = this.effectiveSelector(selector);
		if (eff === undefined) {
			throw new Error(
				`ModuleHcpServer(${this.moduleName}): op "${call.op}" needs a selector (input.selector); ` +
					`module owns [${this.selectors().join(", ")}]`,
			);
		}
		const server = this.magnetServer(eff);
		if (!server) {
			throw new Error(`ModuleHcpServer(${this.moduleName}): no slot "${eff}" for op "${call.op}"`);
		}
		return server.call(call);
	}

	private hasSelectorInput(call: HcpServerRequest): boolean {
		return this.selectorFromCall(call) !== undefined;
	}

	private selectorFromCall(call: HcpServerRequest): string | undefined {
		const input = call.input;
		if (input && typeof input === "object" && !Array.isArray(input)) {
			const sel = (input as Record<string, unknown>).selector;
			if (typeof sel === "string") return sel;
		}
		return undefined;
	}

	/**
	 * HcpServer.describe — module-level aggregate view for `describeModules()` and
	 * the `/dock` menu: enumerates the module's slots. Returns data, not a wrapper.
	 */
	describe(): HcpServerDescription {
		const firstSelector = this.slots.keys().next().value as string | undefined;
		const componentKind = firstSelector
			? (this.magnetServer(firstSelector)?.describe().kind ?? "unknown")
			: "unknown";
		return {
			target: `module:${this.moduleName}`,
			kind: "module",
			ops: ["describe"],
			description: `Module: ${this.moduleName}`,
			metadata: {
				moduleName: this.moduleName,
				slotCount: this.slots.size,
				slots: [...this.slots.keys()],
				componentKind,
			},
		};
	}

	/**
	 * Per-slot descriptions (for `describeAll()` / menu drill-down). Each is the
	 * source magnet server's own `describe()` — the flat address stays authoritative.
	 */
	describeSlots(): HcpServerDescription[] {
		const out: HcpServerDescription[] = [];
		for (const selector of this.slots.keys()) {
			const server = this.magnetServer(selector);
			if (server) out.push(server.describe());
		}
		return out;
	}
}

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
 * `resolve(address)` returns the MODULE-LEVEL HcpServer that owns the address.
 * Consumers that want the implementation call {@link resolveInstance} (or
 * {@link resolveCapability}), which supplies the in-module selector from the
 * routing index so the caller never computes it.
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
	private readonly byPrefix = new Map<string, HcpServerShape>();
	private readonly byAddress = new Map<string, HcpServerShape>();

	/**
	 * Register a module HcpServer and index its slot addresses. Replaces an
	 * existing module of the same name (enables pi's per-runtime tool rebuild).
	 * Returns the addresses registered (for diagnostics).
	 *
	 * @param moduleName Module folder name (e.g. "tools", "compaction", "runtime").
	 * @param slots Map of in-module selector → magnet. For single-slot modules the
	 *              selector is the capability slot name ("compaction"); for
	 *              multi-slot modules it is the component name ("read", "bash",
	 *              "runtime:process").
	 */
	registerModule(moduleName: string, slots: Map<string, HcpMagnetShape>): string[];
	/** @deprecated Use registerModule(moduleName, slots) instead */
	registerModule(module: ModuleHcpServer): string[];
	registerModule(moduleOrName: string | ModuleHcpServer, slots?: Map<string, HcpMagnetShape>): string[] {
		const module = typeof moduleOrName === "string" ? new ModuleHcpServer(moduleOrName, slots!) : moduleOrName;
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
	registerServer(address: string, server: HcpServerShape): this {
		this.addrToModule.delete(address);
		this.byAddress.set(address, server);
		return this;
	}

	/** Register a multi-endpoint provider server under a scheme prefix (e.g. "context"). */
	register(prefix: string, server: HcpServerShape): this {
		this.byPrefix.set(prefix, server);
		return this;
	}

	/**
	 * Resolve an address to the MODULE-LEVEL HcpServer that owns it.
	 * Order: standalone leaf → module server → prefix provider. For a module-owned
	 * address this returns the ModuleHcpServer; call `.instance(selector)`
	 * on it (or use {@link resolveInstance} to have the selector supplied).
	 */
	resolve(address: string): HcpServerShape | undefined {
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
		return this.resolveInstance<T>(`${HcpClientcapabilityprefix}:${name}`) ?? this.resolveInstance<T>(name);
	}

	/** Resolve a module server by its folder name (Model B direct access). */
	resolveModule(name: string): HcpServerShape | undefined {
		return this.byModule.get(name);
	}

	/** All registered module folder names. */
	modules(): string[] {
		return [...this.byModule.keys()];
	}

	/** The module servers themselves (for merging one HCP's modules into another). */
	moduleServers(): Array<{ moduleName: string; slotAddresses: () => Array<{ address: string; selector: string }> }> {
		return [...this.byModule.values()];
	}

	/** Standalone (non-module) leaf addresses, paired with their server (for merge). */
	standaloneEntries(): Array<{ address: string; server: HcpServerShape }> {
		return [...this.byAddress].map(([address, server]) => ({ address, server }));
	}

	/**
	 * Describe the registered module HcpServers as first-class entities,
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
	async dispatch(call: HcpServerRequest): Promise<unknown> {
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
