import { fileURLToPath } from "node:url";
import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { loadSandboxProviderFromPackSync } from "./sandbox.ts";

/** The magenta source's binding for the `sandbox` capability (spec §8). */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "sandbox";
	static readonly kind = "sandbox";
	static readonly source = "magenta";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "sandbox";
		const name = context.name ?? "sandbox";
		const source = context.source ?? "magenta";

		const instance = loadSandboxProviderFromPackSync(
			context.descriptorPath ?? fileURLToPath(new URL("../sandbox.toml", import.meta.url)),
		);

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: `capability:${kind}`,
				description: "The magenta source's binding for the sandbox capability",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
