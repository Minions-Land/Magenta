import type { HcpMagnet } from "../HcpMagnetTypes.ts";
import type { HcpServer, HcpServerDescription, HcpServerRequest } from "../HcpServerTypes.ts";

/**
 * A ModuleHcpServer is the runtime embodiment of one harness module folder
 * (`tools`, `compaction`, `runtime`, …) AND is itself the {@link HcpServer} that
 * `HcpClient.resolve()` returns for any address the module owns. This is strict
 * Model B: the resolution chain is
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
export class ModuleHcpServer implements HcpServer {
	readonly moduleName: string;
	private readonly slots: Map<string, HcpMagnet>;

	/**
	 * @param moduleName Module folder name (e.g. "tools", "compaction", "runtime").
	 * @param slots Map of in-module selector → magnet. For single-slot modules the
	 *              selector is the capability slot name ("compaction"); for
	 *              multi-slot modules it is the component name ("read", "bash",
	 *              "runtime:process").
	 */
	constructor(moduleName: string, slots: Map<string, HcpMagnet>) {
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
	private magnetServer(selector: string): HcpServer | undefined {
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
