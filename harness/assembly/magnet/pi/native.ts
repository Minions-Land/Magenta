import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { HcpCall, HcpTarget, HcpTargetDescription } from "../../hcp/pi/hcp.js";
import type { Magnet } from "./magnet.js";
import {
	createReadExecute,
	type ReadToolOptions,
	readSchema,
} from "../../../tools/index.js";

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
 * A `native` Magnet: wraps a native TS tool factory (from `harness/tools/pi`)
 * into a {@link Magnet} that yields a loop-ready {@link AgentTool} and an
 * {@link HcpTarget} for management. This is assembly-layer wiring only; the
 * produced tool is what the loop calls in-process.
 */
export class NativeToolMagnet<TParameters extends TSchema = TSchema, TDetails = any> implements Magnet {
	readonly kind = "native";
	private readonly spec: NativeToolSpec<TParameters, TDetails>;
	private readonly cwd: string;

	constructor(spec: NativeToolSpec<TParameters, TDetails>, cwd: string) {
		this.spec = spec;
		this.cwd = cwd;
	}

	/** Produce the loop-ready AgentTool. */
	toTool(): AgentTool<TParameters, TDetails> {
		const { name, label, description, parameters, createExecute } = this.spec;
		return {
			name,
			label: label ?? name,
			description,
			parameters,
			execute: createExecute(this.cwd),
		};
	}

	/** Produce an HCP management endpoint describing/dispatching this tool. */
	toHcpTarget(): HcpTarget {
		const spec = this.spec;
		const buildTool = () => this.toTool();
		return {
			describe(): HcpTargetDescription {
				return {
					target: `tool:${spec.name}`,
					kind: "tool",
					ops: ["describe", "toTool"],
					description: spec.description,
				};
			},
			call(call: HcpCall): unknown {
				switch (call.op) {
					case "describe":
						return this.describe();
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
 * Magnet. Demonstrates the assembly path end to end (pure execute + schema +
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
