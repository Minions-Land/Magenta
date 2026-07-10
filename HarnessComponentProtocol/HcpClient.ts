import { HcpClientcapabilityprefix, type HcpServerDescription, type HcpServerRequest } from "./.HCP/HcpServerTypes.ts";

/**
 * HcpServer 的结构化类型约束（规范§2：全仓无 interface，靠结构化类型）。
 * 任何具有这些方法的对象都可以作为 HcpServer 使用。
 */
type HcpServerShape = {
	readonly moduleName: string;
	readonly description?: string;
	readonly metadata?: Record<string, unknown>;
	describe(): HcpServerDescription;
	call(call: HcpServerRequest): Promise<unknown> | unknown;
	instance<T = unknown>(selector?: string): T | undefined;
};

/**
 * HcpMagnet 的结构化类型约束。
 */
type HcpMagnetShape = {
	kind: string;
	readonly source?: string;
	readonly hotSwappable?: boolean;
	toTool?(): unknown;
	toCapability?(): unknown;
	toResource?(): unknown;
	dispose?(): void | Promise<void>;
};

type HcpClientserver = {
	readonly moduleName: string;
	readonly description?: string;
	readonly metadata?: Record<string, unknown>;
	describeSource?(selector: string, magnet: HcpMagnetShape): HcpServerDescription;
	sourceAddresses?(selector: string, magnet: HcpMagnetShape): string[];
	callSource?(selector: string, magnet: HcpMagnetShape, call: HcpServerRequest): Promise<unknown> | unknown;
};

type HcpClientstate = {
	server: HcpClientserver;
	slots: Map<string, HcpMagnetShape>;
	addressesBySlot: Map<string, Set<string>>;
};

/**
 * Extract the name portion from an HCP target address.
 * Handles both "kind:name" and "kind://name" formats.
 * Examples:
 *   "hook:pre-send" → "pre-send"
 *   "hook://pre-tool" → "pre-tool"
 *   "context://workspace" → "workspace"
 */
export function HcpClienttargetname(target: string): string {
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
 * HcpClient — the global, single router of the HCP layer (spec §2, §10.1).
 *
 * A consumer asks for something by address (`"tool:read"`) or capability name
 * (`"compaction"`, `"runtime:process"`) and the client resolves it to the owning
 * module server, which routes to the selected source's implementation. This is
 * the ONE place source selection is consumed; there is no second selection
 * state.
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
 * Storage is deliberately singular: real module Servers plus thin
 * `address -> {module, selector}` routing pointers.
 */
export class HcpClient {
	private readonly byModule = new Map<string, HcpClientstate>();
	private readonly addrToModule = new Map<string, { module: string; selector: string }>();
	private readonly retiredMagnets = new WeakSet<HcpMagnetShape>();
	private readonly pendingRetirements = new WeakSet<HcpMagnetShape>();
	private readonly pendingDisposals = new Set<Promise<void>>();

	/** Release source-owned resources and empty this Client's runtime state. */
	async dispose(): Promise<void> {
		const magnets = new Set<HcpMagnetShape>();
		for (const state of this.byModule.values()) {
			for (const magnet of state.slots.values()) magnets.add(magnet);
		}
		this.addrToModule.clear();
		this.byModule.clear();
		this.retireMagnets(magnets);
		await Promise.all([...this.pendingDisposals]);
	}

	/**
	 * Register a module HcpServer and index its slot addresses. Replacement mode
	 * retires the existing module and descendant subtree. Merge mode updates only
	 * the named module's slots and preserves its real child modules.
	 * Returns the addresses registered (for diagnostics).
	 *
	 * @param server The real server from the module folder being registered.
	 * @param slots Map of in-module selector → magnet. For single-slot modules the
	 *              selector is the capability slot name ("compaction"); for
	 *              multi-slot modules it is the component name ("read", "bash",
	 *              "runtime:process").
	 */
	registerModule(
		server: HcpClientserver,
		slots: Map<string, HcpMagnetShape>,
		options: { merge?: boolean; replace?: boolean; override?: boolean } = {},
	): string[] {
		const existingState = options.merge ? this.byModule.get(server.moduleName) : undefined;
		if (existingState && existingState.server !== server) {
			throw new Error(`HcpClient(${server.moduleName}): merge must reuse the existing HcpServer instance`);
		}
		const preview: HcpClientstate = {
			server,
			slots,
			addressesBySlot: new Map(),
		};
		const nextAddresses = new Map<string, Set<string>>();
		const nextOwners = new Map<string, string>();
		const replacedSelectors = new Set(slots.keys());
		const retired: HcpMagnetShape[] = [];
		for (const [selector, magnet] of slots) {
			if (this.retiredMagnets.has(magnet)) {
				throw new Error(`HcpClient(${server.moduleName}): cannot register retired magnet "${selector}"`);
			}
			const canonical = this.describeSource(preview, selector)?.target;
			const addresses = [...(server.sourceAddresses?.(selector, magnet) ?? (canonical ? [canonical] : []))];
			if (canonical && !addresses.includes(canonical)) addresses.unshift(canonical);
			const uniqueAddresses = new Set(addresses);
			for (const address of uniqueAddresses) {
				const nextOwner = nextOwners.get(address);
				if (nextOwner !== undefined && nextOwner !== selector) {
					throw new Error(
						`HcpClient address collision: "${address}" is produced by both "${nextOwner}" and "${selector}"`,
					);
				}
				nextOwners.set(address, selector);
				const current = this.addrToModule.get(address);
				const replacedByThisCall = options.merge
					? options.replace !== false &&
						current?.module === server.moduleName &&
						replacedSelectors.has(current.selector)
					: current !== undefined && this.isModuleOrDescendant(current.module, server.moduleName);
				if (current && !replacedByThisCall && options.override !== true) {
					throw new Error(
						`HcpClient address collision: "${address}" is already owned by ${current.module}:${current.selector}`,
					);
				}
			}
			nextAddresses.set(selector, uniqueAddresses);
		}
		if (!existingState) {
			Object.assign(server, {
				describe: () => this.describeModule(server.moduleName),
				call: (call: HcpServerRequest) => this.callModule(server.moduleName, call),
				instance: <T>(selector?: string) => this.instanceModule<T>(server.moduleName, selector),
			});
		}

		let state = existingState;
		if (options.override) {
			for (const addresses of nextAddresses.values()) {
				for (const address of addresses) {
					this.evictOverriddenAddress(address, server.moduleName, replacedSelectors, retired);
				}
			}
		}
		if (!options.merge) {
			for (const [address, route] of this.addrToModule) {
				if (this.isModuleOrDescendant(route.module, server.moduleName)) this.addrToModule.delete(address);
			}
			for (const moduleName of this.byModule.keys()) {
				if (!this.isModuleOrDescendant(moduleName, server.moduleName)) continue;
				for (const magnet of this.byModule.get(moduleName)?.slots.values() ?? []) retired.push(magnet);
				this.byModule.delete(moduleName);
			}
		}

		if (state) {
			for (const [selector, magnet] of slots) {
				const previous = state.slots.get(selector);
				if (previous) retired.push(previous);
				for (const address of state.addressesBySlot.get(selector) ?? []) {
					const route = this.addrToModule.get(address);
					if (route?.module === server.moduleName && route.selector === selector) {
						this.addrToModule.delete(address);
					}
				}
				state.addressesBySlot.delete(selector);
				state.slots.set(selector, magnet);
			}
		} else {
			state = {
				server,
				slots: new Map(slots),
				addressesBySlot: new Map(),
			};
			this.byModule.set(server.moduleName, state);
		}

		const registered: string[] = [];
		for (const [selector] of slots) {
			const uniqueAddresses = nextAddresses.get(selector)!;
			state.addressesBySlot.set(selector, uniqueAddresses);
			for (const address of uniqueAddresses) {
				this.addrToModule.set(address, { module: server.moduleName, selector });
				registered.push(address);
			}
		}
		this.retireMagnets(retired);
		return registered;
	}

	private evictOverriddenAddress(
		address: string,
		incomingModule: string,
		incomingSelectors: ReadonlySet<string>,
		retired: HcpMagnetShape[],
	): void {
		const current = this.addrToModule.get(address);
		if (!current) return;
		if (current.module === incomingModule && incomingSelectors.has(current.selector)) return;
		const state = this.byModule.get(current.module);
		if (!state) {
			this.addrToModule.delete(address);
			return;
		}
		const addresses = state.addressesBySlot.get(current.selector);
		addresses?.delete(address);
		this.addrToModule.delete(address);
		if (addresses && addresses.size > 0) return;
		const magnet = state.slots.get(current.selector);
		if (magnet) retired.push(magnet);
		state.slots.delete(current.selector);
		state.addressesBySlot.delete(current.selector);
		if (
			current.module !== incomingModule &&
			state.slots.size === 0 &&
			this.directChildren(current.module).length === 0
		) {
			this.byModule.delete(current.module);
		}
	}

	private retireMagnets(candidates: Iterable<HcpMagnetShape>): void {
		for (const magnet of new Set(candidates)) {
			if (
				this.isMagnetLive(magnet) ||
				this.retiredMagnets.has(magnet) ||
				this.pendingRetirements.has(magnet) ||
				typeof magnet.dispose !== "function"
			) {
				continue;
			}
			this.pendingRetirements.add(magnet);
			const pending = Promise.resolve()
				.then(async () => {
					this.pendingRetirements.delete(magnet);
					if (this.isMagnetLive(magnet) || this.retiredMagnets.has(magnet)) return;
					this.retiredMagnets.add(magnet);
					await magnet.dispose!();
				})
				.then(
					() => undefined,
					() => undefined,
				);
			this.pendingDisposals.add(pending);
			void pending.then(() => this.pendingDisposals.delete(pending));
		}
	}

	private isMagnetLive(candidate: HcpMagnetShape): boolean {
		for (const state of this.byModule.values()) {
			for (const magnet of state.slots.values()) {
				if (magnet === candidate) return true;
			}
		}
		return false;
	}

	/**
	 * Resolve an address to the MODULE-LEVEL HcpServer that owns it.
	 * Call `.instance(selector)` on it, or use {@link resolveInstance} to have the
	 * selector supplied from the routing index.
	 */
	resolve(address: string): HcpServerShape | undefined {
		const route = this.addrToModule.get(address);
		return route ? (this.byModule.get(route.module)?.server as HcpServerShape | undefined) : undefined;
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
	 * when the address is routed), so the caller never spells it out. Leaf/prefix servers are
	 * single-product and are asked for `.instance()` directly.
	 */
	resolveInstance<T>(address: string): T | undefined {
		const route = this.addrToModule.get(address);
		if (route) {
			const module = this.byModule.get(route.module);
			return module ? this.sourceInstance<T>(module, route.selector) : undefined;
		}
		return undefined;
	}

	/**
	 * Resolve a capability by its slot name (for example `"compaction"` or
	 * `"runtime:process"`) to the selected source's typed instance. Sugar over
	 * {@link resolveInstance}: the slot name maps to the address
	 * `capability:<name>`.
	 * Consumers pass only the capability name and never know which source supplied
	 * it. Returns `undefined` when nothing is registered or the target is
	 * inspect-only.
	 */
	resolveCapability<T>(name: string): T | undefined {
		return this.resolveInstance<T>(`${HcpClientcapabilityprefix}:${name}`);
	}

	/** Resolve a module server by its folder name (Model B direct access). */
	resolveModule(name: string): HcpServerShape | undefined {
		return this.byModule.get(name)?.server as HcpServerShape | undefined;
	}

	/** All registered module folder names. */
	modules(): string[] {
		return [...this.byModule.keys()].sort((left, right) => left.localeCompare(right));
	}

	/**
	 * Describe the registered module HcpServers as first-class entities,
	 * each with its slot metadata. This is what a module-grouped management UI (the
	 * `/dock` Harness menu) renders, distinct from {@link describeAll}.
	 */
	describeModules(): HcpServerDescription[] {
		return [...this.byModule.keys()].map((moduleName) => this.describeModule(moduleName));
	}

	/** All flat addresses currently resolvable through module Servers. */
	addresses(): string[] {
		return [...this.addrToModule.keys()];
	}

	/**
	 * Describe all resolvable module targets. Addresses expand to each source
	 * Magnet's per-slot description. The menu filters by `target.startsWith("tool:")` /
	 * `"capability:"` for kind grouping, or uses {@link describeModules} for
	 * folder grouping.
	 */
	describeAll(): HcpServerDescription[] {
		const described = new Map<string, HcpServerDescription>();

		for (const module of this.byModule.values()) {
			for (const selector of module.slots.keys()) {
				const desc = this.describeSource(module, selector);
				if (desc) described.set(desc.target, desc);
			}
		}
		return [...described.values()];
	}

	private sourceInstance<T>(module: HcpClientstate, selector: string): T | undefined {
		const magnet = module.slots.get(selector);
		if (!magnet) return undefined;
		const products = [magnet.toTool, magnet.toCapability, magnet.toResource].filter(
			(product): product is () => unknown => typeof product === "function",
		);
		if (products.length !== 1) {
			throw new Error(
				`HcpClient(${module.server.moduleName}): magnet "${selector}" must produce exactly one product`,
			);
		}
		const product = products[0]!.call(magnet);
		if (magnet.toCapability) {
			if (!product || typeof product !== "object" || !("instance" in product)) {
				throw new Error(`HcpClient(${module.server.moduleName}): capability magnet "${selector}" has no instance`);
			}
			return (product as { instance: T }).instance;
		}
		return product as T;
	}

	private describeSource(module: HcpClientstate, selector: string): HcpServerDescription | undefined {
		const magnet = module.slots.get(selector);
		if (!magnet) return undefined;
		if (module.server.describeSource) return module.server.describeSource(selector, magnet);

		if (magnet.toTool) {
			const tool = magnet.toTool() as { name?: unknown; description?: unknown };
			if (typeof tool.name !== "string") {
				throw new Error(`HcpClient(${module.server.moduleName}): tool magnet "${selector}" has no name`);
			}
			return {
				target: `tool:${tool.name}`,
				kind: "tool",
				ops: ["describe", "call"],
				description: typeof tool.description === "string" ? tool.description : module.server.description,
				metadata: { source: magnet.source },
			};
		}
		if (magnet.toCapability) {
			const binding = magnet.toCapability() as { kind?: unknown; name?: unknown; source?: unknown };
			if (typeof binding.kind !== "string") {
				throw new Error(`HcpClient(${module.server.moduleName}): capability magnet "${selector}" has no kind`);
			}
			return {
				target: `capability:${selector}`,
				kind: binding.kind,
				ops: ["describe", "call"],
				description: module.server.description,
				metadata: {
					name: typeof binding.name === "string" ? binding.name : selector,
					source: binding.source,
					hotSwappable: magnet.hotSwappable ?? false,
				},
			};
		}
		if (magnet.toResource) {
			const resource = magnet.toResource() as {
				kind?: unknown;
				name?: unknown;
				source?: unknown;
				mergeMode?: unknown;
				contentPath?: unknown;
				metadata?: unknown;
			};
			if (typeof resource.kind !== "string" || typeof resource.name !== "string") {
				throw new Error(`HcpClient(${module.server.moduleName}): resource magnet "${selector}" is invalid`);
			}
			return {
				target: `${resource.kind}:${resource.name}`,
				kind: resource.kind,
				ops: ["describe", "resolve"],
				description: module.server.description,
				metadata: {
					...(resource.metadata && typeof resource.metadata === "object"
						? (resource.metadata as Record<string, unknown>)
						: {}),
					name: resource.name,
					source: resource.source,
					mergeMode: resource.mergeMode,
					...(typeof resource.contentPath === "string" ? { contentPath: resource.contentPath } : {}),
				},
			};
		}
		throw new Error(`HcpClient(${module.server.moduleName}): magnet "${selector}" produces no product`);
	}

	private effectiveSelector(module: HcpClientstate, selector?: string): string | undefined {
		if (selector !== undefined) return selector;
		if (module.slots.size === 1) return module.slots.keys().next().value as string;
		return undefined;
	}

	private instanceModule<T>(moduleName: string, selector?: string): T | undefined {
		const module = this.byModule.get(moduleName);
		if (!module) return undefined;
		const effective = this.effectiveSelector(module, selector);
		return effective ? this.sourceInstance<T>(module, effective) : undefined;
	}

	private callModule(moduleName: string, call: HcpServerRequest): Promise<unknown> | unknown {
		const module = this.byModule.get(moduleName);
		if (!module) throw new Error(`HcpClient: no module "${moduleName}"`);
		const selector = this.selectorFromCall(call);
		if (call.op === "describe" && selector === undefined) return this.describeModule(moduleName);
		const effective = this.effectiveSelector(module, selector);
		if (!effective) {
			throw new Error(
				`HcpClient(${moduleName}): op "${call.op}" needs a selector (input.selector); ` +
					`module owns [${[...module.slots.keys()].join(", ")}]`,
			);
		}
		const magnet = module.slots.get(effective);
		if (!magnet) throw new Error(`HcpClient(${moduleName}): no slot "${effective}" for op "${call.op}"`);
		if (module.server.callSource) return module.server.callSource(effective, magnet, call);
		if (call.op === "describe") return this.describeSource(module, effective);
		if (magnet.toTool) {
			if (call.op === "toTool" || call.op === "resolve") return this.sourceInstance(module, effective);
			throw new Error(`HcpClient(${moduleName}): tool slot "${effective}" does not support op "${call.op}"`);
		}
		if (magnet.toCapability) {
			if (call.op === "call" || call.op === "resolve" || call.op === "instance") {
				return this.sourceInstance(module, effective);
			}
			if (call.op === "toTool") {
				throw new Error(`HcpClient(${moduleName}): capability slot "${effective}" does not produce an AgentTool`);
			}
			throw new Error(`HcpClient(${moduleName}): capability slot "${effective}" does not support op "${call.op}"`);
		}
		if (magnet.toResource) {
			if (["resolve", "read", "get"].includes(call.op)) return this.sourceInstance(module, effective);
			throw new Error(`HcpClient(${moduleName}): resource slot "${effective}" does not support op "${call.op}"`);
		}
		throw new Error(`HcpClient(${moduleName}): magnet "${effective}" produces no product`);
	}

	private selectorFromCall(call: HcpServerRequest): string | undefined {
		const input = call.input;
		if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
		const selector = (input as Record<string, unknown>).selector;
		return typeof selector === "string" ? selector : undefined;
	}

	private isModuleOrDescendant(candidate: string, moduleName: string): boolean {
		return candidate === moduleName || candidate.startsWith(`${moduleName}/`);
	}

	private directChildren(moduleName: string): string[] {
		const childPrefix = `${moduleName}/`;
		return [...this.byModule.keys()].filter((candidate) => {
			if (!candidate.startsWith(childPrefix)) return false;
			return !candidate.slice(childPrefix.length).includes("/");
		});
	}

	private describeModule(moduleName: string): HcpServerDescription {
		const module = this.byModule.get(moduleName);
		if (!module) throw new Error(`HcpClient: no module "${moduleName}"`);
		const selectors = [...module.slots.keys()];
		const children = this.directChildren(moduleName);
		const componentKind = selectors[0] ? (this.describeSource(module, selectors[0])?.kind ?? "unknown") : "unknown";
		return {
			target: `module:${moduleName}`,
			kind: "module",
			ops: ["describe"],
			description: module.server.description ?? `Module: ${moduleName}`,
			metadata: {
				moduleName,
				children,
				slotCount: selectors.length,
				slots: selectors,
				componentKind,
				...module.server.metadata,
			},
		};
	}

	/** Dispatch a management call to its resolved module Server. */
	async dispatch(call: HcpServerRequest): Promise<unknown> {
		const target = this.resolve(call.target);
		if (!target) {
			throw new Error(`HCP: no target registered for "${call.target}"`);
		}
		const route = this.addrToModule.get(call.target);
		if (!route) throw new Error(`HCP: target "${call.target}" has no module route`);
		const input = call.input;
		const routedInput =
			input && typeof input === "object" && !Array.isArray(input)
				? { ...(input as Record<string, unknown>), selector: route.selector }
				: { value: input, selector: route.selector };
		return target.call({ ...call, input: routedInput });
	}
}
