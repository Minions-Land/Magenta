import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { createCapabilityServer, targetName } from "../../../harness-component-protocol/server/capability-server.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { HookProvider } from "./hooks.ts";

/**
 * The magenta source's binding for the `hook` capability (spec §8).
 *
 * Wraps HookProvider (pure business logic) in a unified HcpServer adapter,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "hooks";
	static readonly kind = "hook";
	static readonly source = "magenta";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "hook";
		const name = context.name ?? "hook";
		const source = context.source ?? "magenta";

		const provider = new HookProvider();
		const instance = createCapabilityServer({
			kind: "hook",
			target: "hook://*",
			description: "Lifecycle hook provider migrated from Magenta1 general-harness.",
			provider,
			operations: {
				discover: (p) => p.discover(),
				list: (p) => p.discover(),
				describe: (p, req) => p.describeHook(targetName(req.target)),
				run: (p, req) => p.run(targetName(req.target), req.input),
				call: (p, req) => p.run(targetName(req.target), req.input),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
			},
		});

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: "capability:magenta",
				description: "Lifecycle hook provider migrated from Magenta1 general-harness.",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
