import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpCall, HcpTarget, HcpTargetDescription } from "../../hcp/pi/hcp.ts";
import type { Magnet } from "./magnet.ts";

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
export abstract class UniversalMagnet implements Magnet {
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

	describe(): HcpTargetDescription {
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

	toHcpTarget(): HcpTarget {
		return {
			describe: () => this.describe(),
			call: async (call: HcpCall): Promise<unknown> => {
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
						return this.handleHcpCall(call);
				}
			},
		};
	}

	protected assertEnabled(): void {
		if (!this.state.enabled) {
			throw new Error(`${this.descriptor.name} is disabled`);
		}
	}

	protected handleHcpCall(call: HcpCall): Promise<unknown> | unknown {
		throw new Error(`${this.descriptor.name}: unsupported op "${call.op}"`);
	}

	toTool?(): AgentTool;
}
