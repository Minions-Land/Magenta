import type { CapabilitySourceMagnet } from "../../../hcp-client/contract/hcp-magnet.ts";
import { SessionGroundingMemoryProvider } from "./session-grounding.ts";

/** The magenta source's binding for the `memory` capability (spec §8). */
export const memoryMagentaMagnet: CapabilitySourceMagnet = {
	module: "memory",
	kind: "memory",
	source: "magenta",
	isDefault: true,
	build: (context) => new SessionGroundingMemoryProvider({ workspaceRoot: context.repoRoot }),
};
