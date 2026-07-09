import type { HcpMagnetBuildContext } from "../../../../harness-component-protocol/HcpServerTypes.ts";
import { createCapabilityServer } from "../../../../harness-component-protocol/server/capability-server.ts";
import { CapabilityMagnet } from "../../../../hcp-magnet/universal.ts";
import type { OrchestrationRequest } from "../../HcpServer.ts";
import { MultiAgentOrchestrator, PATTERNS, TARGET } from "./orchestrator.ts";

/**
 * The magenta source's binding for the `multiagent` capability (spec §8).
 *
 * Wraps MultiAgentOrchestrator (pure business logic) in a unified HcpServer adapter,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "multiagent";
	static readonly kind = "multiagent";
	static readonly source = "magenta";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "multiagent";
		const name = context.name ?? "multiagent";
		const source = context.source ?? "magenta";

		const provider = new MultiAgentOrchestrator({ cwd: context.repoRoot });
		const instance = createCapabilityServer({
			kind: "multiagent",
			target: TARGET,
			description: "Deterministic multi-agent orchestration workflows.",
			provider,
			operations: {
				discover: (p) => p.discover(),
				orchestrate: (p, req) => p.orchestrate(req.input as OrchestrationRequest),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				patterns: PATTERNS,
			},
		});

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: `capability:${source}`,
				description: "Deterministic multi-agent orchestration workflows.",
				metadata: {
					implementation: "native-ts",
					source: "magenta",
					patterns: PATTERNS,
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: "magenta",
			instance,
		});
	}
}
