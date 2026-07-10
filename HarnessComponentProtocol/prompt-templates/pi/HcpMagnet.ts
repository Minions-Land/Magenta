import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { PromptTemplateProvider } from "./prompt-templates.ts";

/**
 * The pi source's binding for the `prompt-template` capability (spec §8).
 * 按照规范§2 + 头号铁律：裸 class，不继承任何基类。名字 = Hcp + Magnet。
 */
export class HcpMagnet {
	static readonly module = "prompt-templates";
	static readonly kind = "prompt-template";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "capability:prompt-template";
	readonly hotSwappable: boolean;
	private readonly capabilityKind: string;
	private readonly name: string;
	readonly source: string;
	private readonly instance: PromptTemplateProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "prompt-template";
		this.name = context.name ?? "prompt-template";
		this.source = context.source ?? "pi";
		this.hotSwappable = context.hotSwappable ?? false;
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
}
