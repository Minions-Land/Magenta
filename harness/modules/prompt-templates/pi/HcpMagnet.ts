import type { HcpMagnetBinding } from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpMagnetBuildContext,
	HcpServerDescription,
	HcpServerRequest,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { PromptTemplateProvider } from "./prompt-templates.ts";

/**
 * The pi source's binding for the `prompt-template` capability (spec §8).
 * 按照规范§2 + 头号铁律：裸 class，不继承任何基类。名字 = Hcp + Magnet。
 */
export class HcpMagnet {
	static readonly module = "prompt-templates";
	static readonly kind = "prompt-template";
	static readonly source = "pi";
	static readonly isDefault = true;

	readonly kind = "capability:prompt-template";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly instance: PromptTemplateProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "prompt-template";
		this.name = context.name ?? "prompt-template";
		this.source = context.source ?? "pi";
		this.instance = new PromptTemplateProvider();
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
				description: "Prompt template provider from pi",
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
