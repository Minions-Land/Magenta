import type {
	HcpMagnetBinding,
} from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpServerDescription,
	HcpServerRequest,
	HcpMagnetBuildContext,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { PolicyProvider } from "./policy.ts";

/**
 * The magenta source's binding for the `policy` capability (spec §8).
 * 按照规范§2：裸 class，不 implements、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "policy";
	static readonly kind = "policy";
	static readonly source = "magenta";
	static readonly isDefault = true;

	readonly kind = "native";
	private readonly provider: PolicyProvider;

	constructor(_context: HcpMagnetBuildContext) {
		this.provider = new PolicyProvider();
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: "policy",
			name: "policy",
			source: "magenta",
			instance: this.provider,
		};
	}

	toHcpServer() {
		return {
			describe: (): HcpServerDescription => ({
				target: "capability:policy",
				kind: "policy",
				ops: ["decideApproval", "classifyShellCommand", "call"],
				description: "Policy bundle containing approval and shell sub-providers.",
				metadata: {
					implementation: "native-ts",
					source: "magenta",
				},
			}),
			call: async (request: HcpServerRequest): Promise<unknown> => {
				const op = request.op || "call";
				switch (op) {
					case "decideApproval":
					case "call":
						return this.provider.decideApproval(request.input);
					case "classifyShellCommand":
						return this.provider.classifyShellCommand(request.input);
					default:
						throw new Error(`Unknown operation: ${op} for policy capability`);
				}
			},
			instance: <T = unknown>(_selector?: string): T | undefined => this.provider as unknown as T,
		};
	}
}
