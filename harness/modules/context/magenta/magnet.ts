import type { CapabilitySourceMagnet } from "../../../hcp-client/contract/hcp-magnet.ts";
import { createCapabilityServer, targetName } from "../../../hcp-client/server/capability-server.ts";
import { ContextProvider } from "./context.ts";

/**
 * The magenta source's binding for the `context` capability (spec §8).
 *
 * Wraps ContextProvider (pure business logic) in a unified HcpServer adapter,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export const contextMagentaMagnet: CapabilitySourceMagnet = {
	module: "context",
	kind: "context",
	source: "magenta",
	isDefault: true,
	build: () => {
		const provider = new ContextProvider({});
		return createCapabilityServer({
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
	},
};
