import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { createCapabilityServer } from "../../../harness-component-protocol/server/capability-server.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { SessionGroundingMemoryProvider } from "./session-grounding.ts";

/**
 * The magenta source's binding for the `memory` capability (spec §8).
 *
 * Wraps the session-grounding memory provider (pure business logic) in a
 * unified HcpServer adapter, making HcpServer an explicit layer.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "memory";
	static readonly kind = "memory";
	static readonly source = "magenta";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "memory";
		const name = context.name ?? "memory";
		const source = context.source ?? "magenta";

		const provider = new SessionGroundingMemoryProvider({ workspaceRoot: context.repoRoot });
		const instance = createCapabilityServer({
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

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: "capability:magenta",
				description: "Session-scoped memory with JSON-lines persistence for lightweight grounding facts.",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
