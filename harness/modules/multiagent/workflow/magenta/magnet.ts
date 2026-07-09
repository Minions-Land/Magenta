import type { CapabilitySourceMagnet } from "../../../../hcp-client/contract/hcp-magnet.ts";
import { createCapabilityServer } from "../../../../hcp-client/server/capability-server.ts";
import type { OrchestrationRequest } from "../../contract.ts";
import { MultiAgentOrchestrator, PATTERNS, TARGET } from "./orchestrator.ts";

/**
 * The magenta source's binding for the `multiagent` capability (spec §8).
 *
 * Wraps MultiAgentOrchestrator (pure business logic) in a unified HcpServer adapter,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export const multiagentMagentaMagnet: CapabilitySourceMagnet = {
	module: "multiagent",
	kind: "multiagent",
	source: "magenta",
	isDefault: true,
	build: (context) => {
		const provider = new MultiAgentOrchestrator({ cwd: context.repoRoot });
		return createCapabilityServer({
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
	},
};
