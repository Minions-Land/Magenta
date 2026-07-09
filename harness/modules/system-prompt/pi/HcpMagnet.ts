import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { SystemPromptProvider } from "./provider.ts";

/**
 * The pi source's binding for the `system-prompt` CAPABILITY (spec §8).
 *
 * Note: this is the code provider face of system-prompt (skills formatting,
 * descriptor loading), which is a legitimate Capability. It is distinct from a
 * package's content-only SYSTEM.md, which is a Resource (spec §5/§5.1) and never
 * flows through this builder. See system-prompt-resource-regression.test.ts.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "system-prompt";
	static readonly kind = "system-prompt";
	static readonly source = "pi";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "system-prompt";
		const name = context.name ?? "system-prompt";
		const source = context.source ?? "pi";

		const instance = new SystemPromptProvider();

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: `capability:${kind}`,
				description: "System prompt capability from pi source",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
