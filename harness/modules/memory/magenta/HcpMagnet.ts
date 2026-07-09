import type {
	HcpMagnetBinding,
} from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpServerDescription,
	HcpServerRequest,
	HcpMagnetBuildContext,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { SessionGroundingMemoryProvider } from "./session-grounding.ts";

/**
 * The magenta source's binding for the `memory` capability (spec §8).
 * 按照规范§2：裸 class，不 implements、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "memory";
	static readonly kind = "memory";
	static readonly source = "magenta";
	static readonly isDefault = true;

	readonly kind = "capability:memory";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly hotSwappable: boolean;
	private readonly provider: SessionGroundingMemoryProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "memory";
		this.name = context.name ?? "memory";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new SessionGroundingMemoryProvider({ workspaceRoot: context.repoRoot });
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.name,
			source: this.source,
			instance: this.provider,
		};
	}

	toHcpServer() {
		return {
			describe: (): HcpServerDescription => ({
				target: `capability:${this.capabilityKind}`,
				kind: this.capabilityKind,
				ops: ["discover", "list", "describe", "read", "get", "inject", "retain", "recall", "reflect"],
				description: "Session-scoped memory with JSON-lines persistence for lightweight grounding facts.",
				metadata: {
					name: this.name,
					implementation: "native-ts",
					source: this.source,
					origin: "magenta1-general-harness",
					hotSwappable: this.hotSwappable,
				},
			}),
			call: async (request: HcpServerRequest): Promise<unknown> => {
				const op = request.op || "read";
				switch (op) {
					case "discover":
					case "list":
						return this.provider.discover();
					case "describe":
						return this.provider.describe();
					case "read":
					case "get":
					case "inject":
						return this.provider.read();
					case "retain":
						return this.provider.retain(request.input);
					case "recall":
						return this.provider.recall(request.input);
					case "reflect":
						return this.provider.reflect(request.input);
					default:
						throw new Error(`Unknown operation: ${op} for memory capability`);
				}
			},
			instance: <T = unknown>(_selector?: string): T | undefined => this.provider as unknown as T,
		};
	}
}
