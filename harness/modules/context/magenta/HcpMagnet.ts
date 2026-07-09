import type {
	HcpMagnetBinding,
} from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpServerDescription,
	HcpServerRequest,
	HcpMagnetBuildContext,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { ContextProvider } from "./context.ts";

/**
 * The magenta source's binding for the `context` capability (spec §8).
 * 按照规范§2：裸 class，不 implements、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "context";
	static readonly kind = "context";
	static readonly source = "magenta";
	static readonly isDefault = true;

	readonly kind = "capability:context";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly hotSwappable: boolean;
	private readonly provider: ContextProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "context";
		this.name = context.name ?? "context";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new ContextProvider({});
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
				ops: ["discover", "list", "read", "call", "status", "describe"],
				description: "Discover project instruction files and return model-safe context content.",
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
						return {
							name: "project-context",
							target: "context://project",
							aliases: ["context://workspace"],
							description: "Discover project instruction files and return model-safe context content.",
							operations: ["read", "status"],
						};
					case "read":
					case "call":
						return this.provider.read();
					case "status":
						return this.provider.status();
					default:
						throw new Error(`Unknown operation: ${op} for context capability`);
				}
			},
			instance: <T = unknown>(_selector?: string): T | undefined => this.provider as unknown as T,
		};
	}
}
