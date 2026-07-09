import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { PromptTemplateProvider } from "./prompt-templates.ts";

/** The pi source's binding for the `prompt-template` capability (spec §8). */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "prompt-templates";
	static readonly kind = "prompt-template";
	static readonly source = "pi";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "prompt-template";
		const name = context.name ?? "prompt-template";
		const source = context.source ?? "pi";

		const instance = new PromptTemplateProvider();

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: `capability:${kind}`,
				description: "Prompt template provider from pi",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
