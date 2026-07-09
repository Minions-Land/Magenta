import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { piCompactionProvider } from "./provider.ts";

/**
 * The pi source's binding for the `compaction` capability (spec §8).
 *
 * Lives next to the implementation it builds and imports the provider via a
 * literal sibling import, so it survives the build extension rewrite. Registered
 * centrally only through the dumb `sources.ts` barrel.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "compaction";
	static readonly kind = "compaction";
	static readonly source = "pi";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "compaction";
		const name = context.name ?? "compaction";
		const source = context.source ?? "pi";

		const instance = piCompactionProvider;

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: `capability:${kind}`,
				description: "Compaction capability from pi source",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
