import type { CapabilitySourceMagnet } from "../../../hcp-client/contract/hcp-magnet.ts";
import { createCapabilityServer, targetName } from "../../../hcp-client/server/capability-server.ts";
import { HookProvider } from "./hooks.ts";

/**
 * The magenta source's binding for the `hook` capability (spec §8).
 *
 * Wraps HookProvider (pure business logic) in a unified HcpServer adapter,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export const hookMagentaMagnet: CapabilitySourceMagnet = {
	module: "hooks",
	kind: "hook",
	source: "magenta",
	isDefault: true,
	build: () => {
		const provider = new HookProvider();
		return createCapabilityServer({
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
	},
};
