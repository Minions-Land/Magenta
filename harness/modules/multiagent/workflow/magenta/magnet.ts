import type { CapabilitySourceMagnet } from "../../../../hcp-client/contract/hcp-magnet.ts";
import { MultiAgentOrchestrator } from "./orchestrator.ts";

/** The magenta source's binding for the `multiagent` capability (spec §8). */
export const multiagentMagentaMagnet: CapabilitySourceMagnet = {
	module: "multiagent",
	kind: "multiagent",
	source: "magenta",
	isDefault: true,
	build: (context) => new MultiAgentOrchestrator({ cwd: context.repoRoot }),
};
