import type { HcpMagnetBinding } from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpMagnetBuildContext,
	HcpServerDescription,
	HcpServerRequest,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { SystemPromptProvider } from "./provider.ts";

/**
 * The pi source's binding for the `system-prompt` CAPABILITY (spec §8).
 * 按照规范§2 + 头号铁律：裸 class，不继承任何基类。名字 = Hcp + Magnet。
 *
 * Note: this is the code provider face of system-prompt (skills formatting,
 * descriptor loading), which is a legitimate Capability. It is distinct from a
 * package's content-only SYSTEM.md, which is a Resource (spec §5/§5.1).
 */
export class HcpMagnet {
	static readonly module = "system-prompt";
	static readonly kind = "system-prompt";
	static readonly source = "pi";
	static readonly isDefault = true;

	readonly kind = "capability:system-prompt";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly instance: SystemPromptProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "system-prompt";
		this.name = context.name ?? "system-prompt";
		this.source = context.source ?? "pi";
		this.instance = new SystemPromptProvider();
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
				description: "System prompt capability from pi source",
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
