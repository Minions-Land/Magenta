import type { CapabilitySourceMagnet } from "../../assembly/magnet/source-magnet.ts";
import { SystemPromptProvider } from "./provider.ts";

/**
 * The pi source's binding for the `system-prompt` CAPABILITY (spec §8).
 *
 * Note: this is the code provider face of system-prompt (skills formatting,
 * descriptor loading), which is a legitimate Capability. It is distinct from a
 * package's content-only SYSTEM.md, which is a Resource (spec §5/§5.1) and never
 * flows through this builder. See system-prompt-resource-regression.test.ts.
 */
export const systemPromptPiMagnet: CapabilitySourceMagnet = {
	kind: "system-prompt",
	source: "pi",
	isDefault: true,
	build: () => new SystemPromptProvider(),
};
