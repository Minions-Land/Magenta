import type {
	HcpMagnetBinding,
} from "../../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpServerDescription,
	HcpServerRequest,
	HcpMagnetBuildContext,
} from "../../../../harness-component-protocol/HcpServerTypes.ts";
import type { OrchestrationRequest } from "../../HcpServer.ts";
import { MultiAgentOrchestrator, PATTERNS, TARGET } from "./orchestrator.ts";

/**
 * The magenta source's binding for the `multiagent` capability (spec §8).
 * 按照规范§2：裸 class，不 implements、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "multiagent";
	static readonly kind = "multiagent";
	static readonly source = "magenta";
	static readonly isDefault = true;

	readonly kind = "native";
	private readonly provider: MultiAgentOrchestrator;

	constructor(context: HcpMagnetBuildContext) {
		this.provider = new MultiAgentOrchestrator({ cwd: context.repoRoot });
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: "multiagent",
			name: "multiagent",
			source: "magenta",
			instance: this.provider,
		};
	}

	toHcpServer() {
		return {
			describe: (): HcpServerDescription => ({
				target: "capability:multiagent",
				kind: "multiagent",
				ops: ["discover", "orchestrate", "call"],
				description: "Deterministic multi-agent orchestration workflows.",
				metadata: {
					implementation: "native-ts",
					source: "magenta",
					patterns: PATTERNS,
				},
			}),
			call: async (request: HcpServerRequest): Promise<unknown> => {
				const op = request.op || "orchestrate";
				switch (op) {
					case "discover":
						return this.provider.discover();
					case "orchestrate":
					case "call":
						return this.provider.orchestrate(request.input as OrchestrationRequest);
					default:
						throw new Error(`Unknown operation: ${op} for multiagent capability at ${TARGET}`);
				}
			},
			instance: <T = unknown>(_selector?: string): T | undefined => this.provider as unknown as T,
		};
	}
}
