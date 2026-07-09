import { targetName } from "../../../harness-component-protocol/HcpClient.ts";
import type {
	HcpMagnetBinding,
} from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpServerDescription,
	HcpServerRequest,
	HcpMagnetBuildContext,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { HookProvider } from "./hooks.ts";

/**
 * The magenta source's binding for the `hook` capability (spec §8).
 * 按照规范§2：裸 class，不 implements、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "hooks";
	static readonly kind = "hook";
	static readonly source = "magenta";
	static readonly isDefault = true;

	readonly kind = "capability:hook";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly hotSwappable: boolean;
	private readonly provider: HookProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "hook";
		this.name = context.name ?? "hook";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new HookProvider();
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
				ops: ["discover", "list", "describe", "run", "call"],
				description: "Lifecycle hook provider migrated from Magenta1 general-harness.",
				metadata: {
					name: this.name,
					implementation: "native-ts",
					source: this.source,
					origin: "magenta1-general-harness",
					hotSwappable: this.hotSwappable,
				},
			}),
			call: async (request: HcpServerRequest): Promise<unknown> => {
				const op = request.op || "run";
				switch (op) {
					case "discover":
					case "list":
						return this.provider.discover();
					case "describe":
						return this.provider.describeHook(targetName(request.target));
					case "run":
					case "call":
						return this.provider.run(targetName(request.target), request.input);
					default:
						throw new Error(`Unknown operation: ${op} for hook capability at ${request.target}`);
				}
			},
			instance: <T = unknown>(_selector?: string): T | undefined => this.provider as unknown as T,
		};
	}
}
