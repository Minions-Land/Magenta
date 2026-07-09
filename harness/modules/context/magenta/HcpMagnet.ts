import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { createCapabilityServer } from "../../../harness-component-protocol/server/capability-server.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { ContextProvider } from "./context.ts";

/**
 * The magenta source's binding for the `context` capability (spec §8).
 *
 * Wraps ContextProvider (pure business logic) in a unified HcpServer adapter,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "context";
	static readonly kind = "context";
	static readonly source = "magenta";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "context";
		const name = context.name ?? "context";
		const source = context.source ?? "magenta";

		const provider = new ContextProvider({});
		const instance = createCapabilityServer({
			kind: "context",
			target: "context://{workspace,project}",
			description: "Discover project instruction files and return model-safe context content.",
			provider,
			operations: {
				discover: (p) => p.discover(),
				list: (p) => p.discover(),
				describe: (_p, req) => ({
					name: "project-context",
					target: "context://project",
					aliases: ["context://workspace"],
					description: "Discover project instruction files and return model-safe context content.",
					operations: ["read", "status"],
				}),
				read: (p) => p.read(),
				call: (p) => p.read(),
				status: (p) => p.status(),
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
				description: "Discover project instruction files and return model-safe context content.",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
