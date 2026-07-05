import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CapabilityBinding, HcpMagnet, HcpResource, ResourceMergeMode } from "../hcp-contract/hcp-magnet.ts";
import type { HcpRequest, HcpServer, HcpServerDescription } from "../hcp-contract/hcp-server.ts";

export interface UniversalMagnetState {
	enabled: boolean;
	config: Record<string, unknown>;
}

export interface UniversalMagnetDescriptor {
	target: string;
	kind: string;
	name: string;
	implementation: string;
	description?: string;
	ops?: string[];
	metadata?: Record<string, unknown>;
}

export interface UniversalMagnetOptions {
	descriptor: UniversalMagnetDescriptor;
	initialConfig?: Record<string, unknown>;
}

/**
 * Base class for magnets that need a consistent HCP management surface.
 *
 * This keeps selectors and assembly code from caring whether an implementation is
 * native TS, a Rust process tool, a JSONL HCP process, MCP, WASM, or a remote API.
 */
export abstract class UniversalMagnet implements HcpMagnet {
	readonly kind: string;
	protected readonly descriptor: UniversalMagnetDescriptor;
	protected readonly state: UniversalMagnetState;

	constructor(options: UniversalMagnetOptions) {
		this.kind = options.descriptor.implementation;
		this.descriptor = options.descriptor;
		this.state = {
			enabled: true,
			config: { ...(options.initialConfig ?? {}) },
		};
	}

	describe(): HcpServerDescription {
		return {
			target: this.descriptor.target,
			kind: this.descriptor.kind,
			ops: this.descriptor.ops ?? ["describe", "configure", "enable", "disable", "health", "state"],
			description: this.descriptor.description,
			metadata: {
				name: this.descriptor.name,
				implementation: this.descriptor.implementation,
				enabled: this.state.enabled,
				...this.descriptor.metadata,
			},
		};
	}

	configure(input: unknown): UniversalMagnetState {
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			throw new Error(`${this.descriptor.name}: configure expects an object`);
		}
		this.state.config = { ...this.state.config, ...(input as Record<string, unknown>) };
		return this.currentState();
	}

	enable(): UniversalMagnetState {
		this.state.enabled = true;
		return this.currentState();
	}

	disable(): UniversalMagnetState {
		this.state.enabled = false;
		return this.currentState();
	}

	currentState(): UniversalMagnetState {
		return {
			enabled: this.state.enabled,
			config: { ...this.state.config },
		};
	}

	health(): Record<string, unknown> | Promise<Record<string, unknown>> {
		return {
			status: this.state.enabled ? "ok" : "disabled",
			target: this.descriptor.target,
			implementation: this.descriptor.implementation,
		};
	}

	toHcpServer(): HcpServer {
		const base: HcpServer = {
			describe: () => this.describe(),
			call: async (call: HcpRequest): Promise<unknown> => {
				switch (call.op) {
					case "describe":
						return this.describe();
					case "configure":
						return this.configure(call.input);
					case "enable":
						return this.enable();
					case "disable":
						return this.disable();
					case "state":
						return this.currentState();
					case "health":
						return this.health();
					case "toTool":
						if (!this.toTool) {
							throw new Error(`${this.descriptor.name}: this magnet does not produce an AgentTool`);
						}
						return this.toTool();
					default:
						return this.handleHcpRequest(call);
				}
			},
		};
		// Expose the typed product (an AgentTool for a tool magnet, the selected
		// source impl for a capability magnet) via instance(), so assembly resolves
		// the product THROUGH HCP rather than off the raw magnet. Management-only
		// magnets return undefined here, which resolveCapability / the assembly
		// loop treat as "no instance".
		base.instance = <U>(): U => this.hcpInstance() as U;
		return base;
	}

	/**
	 * The typed product this magnet's HCP target hands back when resolved. By
	 * default a tool magnet returns its {@link AgentTool}; capability magnets
	 * override this to return the selected-source implementation. Returns
	 * undefined for pure management targets (no tool, no capability), which get
	 * no instance() accessor.
	 */
	protected hcpInstance(): unknown {
		return this.toTool ? this.toTool() : undefined;
	}

	protected assertEnabled(): void {
		if (!this.state.enabled) {
			throw new Error(`${this.descriptor.name} is disabled`);
		}
	}

	protected handleHcpRequest(call: HcpRequest): Promise<unknown> | unknown {
		throw new Error(`${this.descriptor.name}: unsupported op "${call.op}"`);
	}

	toTool?(): AgentTool;
}

export interface CapabilityMagnetOptions<T> extends UniversalMagnetOptions {
	/** Selected source that supplied the implementation, e.g. `"pi"`, `"magenta"`. */
	source: string;
	/** The source-selected implementation object, resolved by the assembly layer. */
	instance: T;
}

/**
 * A {@link UniversalMagnet} for non-tool capabilities (compaction, memory,
 * context, ...). It carries a source-selected, in-process implementation and
 * exposes it as a {@link CapabilityBinding} for consumers to inject — instead
 * of an {@link AgentTool}. The full HCP management surface (describe/configure/
 * enable/disable/health/state) is inherited unchanged, so `describe()` sees the
 * capability under its own kind (`compaction://compaction`) and the LLM tool
 * hot path is never touched.
 *
 * Invariant (magnet one-of): this class deliberately does NOT implement
 * `toTool`; it only implements `toCapability`.
 */
export class CapabilityMagnet<T = unknown> extends UniversalMagnet {
	private readonly source: string;
	private readonly instance: T;

	constructor(options: CapabilityMagnetOptions<T>) {
		super(options);
		this.source = options.source;
		this.instance = options.instance;
	}

	toCapability(): CapabilityBinding<T> {
		this.assertEnabled();
		return {
			kind: this.descriptor.kind,
			name: this.descriptor.name,
			source: this.source,
			instance: this.instance,
		};
	}

	/**
	 * The selected-source implementation this capability carries. Exposing it via
	 * {@link UniversalMagnet.hcpInstance} makes `toHcpServer().instance()` and
	 * `toCapability().instance` the SAME object — so HCP is the one resolver: a
	 * consumer asking HCP to resolve this capability by name gets exactly what the
	 * binding holds.
	 */
	protected override hcpInstance(): unknown {
		return this.instance;
	}
}

export interface ResourceMagnetOptions extends UniversalMagnetOptions {
	/** Selected source that supplied the content, e.g. `"pi"`, `"AutOmicScience"`. */
	source: string;
	/** How this resource combines with others in the same slot. Defaults to `replace`. */
	mergeMode?: ResourceMergeMode;
	/** Absolute path the content was loaded from, when file-backed. */
	contentPath?: string;
	/** Inline content, when the resource carries data directly rather than a path. */
	content?: string;
}

/**
 * A {@link UniversalMagnet} for the Resource primitive (spec §5): injected
 * context **data** such as a package's `SYSTEM.md` system-prompt content. It
 * carries inert, source-selected content (path or inline) and exposes it as a
 * {@link HcpResource} for the resource layer to inject or override — it is NOT
 * a code provider and never lands on the LLM tool hot path.
 *
 * Invariant (magnet one-of): this class deliberately implements neither
 * `toTool` nor `toCapability`; it only implements `toResource`. This is the
 * structural guard against the §5.1 category error (a content-only resource
 * being mis-routed through capability code-builder resolution).
 */
export class ResourceMagnet extends UniversalMagnet {
	private readonly source: string;
	private readonly mergeMode: ResourceMergeMode;
	private readonly contentPath?: string;
	private readonly content?: string;

	constructor(options: ResourceMagnetOptions) {
		super(options);
		this.source = options.source;
		this.mergeMode = options.mergeMode ?? "replace";
		this.contentPath = options.contentPath;
		this.content = options.content;
	}

	toResource(): HcpResource {
		this.assertEnabled();
		return {
			kind: this.descriptor.kind,
			name: this.descriptor.name,
			source: this.source,
			mergeMode: this.mergeMode,
			contentPath: this.contentPath,
			content: this.content,
		};
	}

	/**
	 * A Resource has no live instance to hand back on the hot path — it is data,
	 * not a callable. `toHcpServer().instance()` therefore resolves to the
	 * resource binding itself, so HCP can surface the content through the same
	 * single-resolver path without inventing a code provider.
	 */
	protected override hcpInstance(): unknown {
		return this.toResource();
	}
}
