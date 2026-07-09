import type { CapabilitySourceMagnet } from "../../../hcp-client/contract/hcp-magnet.ts";
import { createCapabilityServer } from "../../../hcp-client/server/capability-server.ts";
import { SessionGroundingMemoryProvider } from "./session-grounding.ts";

/**
 * The magenta source's binding for the `memory` capability (spec §8).
 *
 * Wraps the session-grounding memory provider (pure business logic) in a
 * unified HcpServer adapter, making HcpServer an explicit layer.
 */
export const memoryMagentaMagnet: CapabilitySourceMagnet = {
	module: "memory",
	kind: "memory",
	source: "magenta",
	isDefault: true,
	build: (context) => {
		const provider = new SessionGroundingMemoryProvider({ workspaceRoot: context.repoRoot });
		return createCapabilityServer({
			kind: "memory",
			target: "memory://session-grounding",
			description: "Session-scoped memory with JSON-lines persistence for lightweight grounding facts.",
			provider,
			operations: {
				discover: (p) => p.discover(),
				list: (p) => p.discover(),
				describe: (p) => p.describe(),
				read: (p) => p.read(),
				get: (p) => p.read(),
				inject: (p) => p.read(),
				retain: (p, req) => p.retain(req.input),
				recall: (p, req) => p.recall(req.input),
				reflect: (p, req) => p.reflect(req.input),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
				storePath: context.repoRoot,
			},
		});
	},
};
