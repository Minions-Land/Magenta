import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { createReadExecute, type ReadToolOptions, readSchema } from "../../tools/index.ts";
import type { HcpRequest, HcpServer, HcpServerDescription } from "../hcp/hcp.ts";
import type { HcpMagnet } from "./magnet.ts";
import type { UniversalMagnetState } from "./universal.ts";

/**
 * Declarative spec for a native TS tool: the pure pieces a
 * `harness/tools/pi/<tool>` module exposes. A {@link NativeToolMagnet} combines
 * these into a loop-ready {@link AgentTool}.
 */
export interface NativeToolSpec<TParameters extends TSchema = TSchema, TDetails = any> {
	/** Tool name as the model sees it (for example `"read"`). */
	name: string;
	/** Human-readable label for UI display. Defaults to `name`. */
	label?: string;
	/** Description string surfaced to the model. */
	description: string;
	/** TypeBox parameter schema. */
	parameters: TParameters;
	/** Build the pure execute function bound to a working directory. */
	createExecute: (cwd: string) => AgentTool<TParameters, TDetails>["execute"];
}

/**
 * A `native` HcpMagnet: wraps a native TS tool factory (from `harness/tools/pi`)
 * into a {@link HcpMagnet} that yields a loop-ready {@link AgentTool} and an
 * {@link HcpServer} for management. This is assembly-layer wiring only; the
 * produced tool is what the loop calls in-process.
 */
export class NativeToolMagnet<TParameters extends TSchema = TSchema, TDetails = any> implements HcpMagnet {
	readonly kind = "native";
	private readonly spec: NativeToolSpec<TParameters, TDetails>;
	private readonly cwd: string;
	private enabled = true;
	private config: Record<string, unknown> = {};

	constructor(spec: NativeToolSpec<TParameters, TDetails>, cwd: string) {
		this.spec = spec;
		this.cwd = cwd;
	}

	/** Produce the loop-ready AgentTool. */
	toTool(): AgentTool<TParameters, TDetails> {
		if (!this.enabled) {
			throw new Error(`native tool magnet "${this.spec.name}" is disabled`);
		}
		const { name, label, description, parameters, createExecute } = this.spec;
		return {
			name,
			label: label ?? name,
			description,
			parameters,
			execute: createExecute(this.cwd),
		};
	}

	private state(): UniversalMagnetState {
		return {
			enabled: this.enabled,
			config: { ...this.config },
		};
	}

	/** Produce an HCP management endpoint describing/dispatching this tool. */
	toHcpServer(): HcpServer {
		const spec = this.spec;
		const self = this;
		const buildTool = () => this.toTool();
		return {
			describe(): HcpServerDescription {
				return {
					target: `tool:${spec.name}`,
					kind: "tool",
					ops: ["describe", "configure", "enable", "disable", "health", "state", "toTool"],
					description: spec.description,
					metadata: {
						name: spec.name,
						implementation: "native",
						enabled: self.enabled,
					},
				};
			},
			call(call: HcpRequest): unknown {
				switch (call.op) {
					case "describe":
						return this.describe();
					case "configure":
						if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
							throw new Error(`native tool magnet "${spec.name}": configure expects an object`);
						}
						self.config = { ...self.config, ...(call.input as Record<string, unknown>) };
						return self.state();
					case "enable":
						self.enabled = true;
						return self.state();
					case "disable":
						self.enabled = false;
						return self.state();
					case "state":
						return self.state();
					case "health":
						return {
							status: self.enabled ? "ok" : "disabled",
							target: `tool:${spec.name}`,
							implementation: "native",
						};
					case "toTool":
						return buildTool();
					default:
						throw new Error(`native tool magnet "${spec.name}": unsupported op "${call.op}"`);
				}
			},
		};
	}
}

/**
 * Proof wiring: the `read` tool from `harness/tools/pi` connected as a native
 * HcpMagnet. Demonstrates the assembly path end to end (pure execute + schema +
 * description -> AgentTool) without pulling in any pi rendering concerns.
 */
export function createReadMagnet(cwd: string, options?: ReadToolOptions): NativeToolMagnet<typeof readSchema> {
	return new NativeToolMagnet(
		{
			name: "read",
			label: "Read",
			description: "Read the contents of a file (with optional line offset/limit).",
			parameters: readSchema,
			createExecute: (boundCwd) => createReadExecute(boundCwd, options) as AgentTool<typeof readSchema>["execute"],
		},
		cwd,
	);
}
