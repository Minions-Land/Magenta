import { fileURLToPath } from "node:url";
import type { HcpMagnetBinding } from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpMagnetBuildContext,
	HcpServerDescription,
	HcpServerRequest,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { loadSandboxProviderFromPackSync, type SandboxProvider } from "./sandbox.ts";

/**
 * The magenta source's binding for the `sandbox` capability (spec §8).
 * 按照规范§2 + 头号铁律：裸 class，不继承任何基类。名字 = Hcp + Magnet。
 */
export class HcpMagnet {
	static readonly module = "sandbox";
	static readonly kind = "sandbox";
	static readonly source = "magenta";
	static readonly isDefault = true;

	readonly kind = "capability:sandbox";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly instance: SandboxProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "sandbox";
		this.name = context.name ?? "sandbox";
		this.source = context.source ?? "magenta";
		this.instance = loadSandboxProviderFromPackSync(
			context.descriptorPath ?? fileURLToPath(new URL("../sandbox.toml", import.meta.url)),
		);
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.name,
			source: this.source,
			instance: this.instance,
		};
	}

	toHcpServer() {
		return {
			describe: (): HcpServerDescription => ({
				target: `capability:${this.capabilityKind}`,
				kind: this.capabilityKind,
				ops: ["describe", "health"],
				description: "The magenta source's binding for the sandbox capability",
				metadata: {
					name: this.name,
					implementation: `capability:${this.capabilityKind}`,
					source: this.source,
				},
			}),
			call: async (_call: HcpServerRequest): Promise<unknown> => this.instance,
			instance: <T = unknown>(_selector?: string): T | undefined => this.instance as unknown as T,
		};
	}
}
