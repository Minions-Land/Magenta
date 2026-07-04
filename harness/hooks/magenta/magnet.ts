import type { CapabilitySourceMagnet } from "../../assembly/magnet/source-magnet.ts";
import { HookProvider } from "./hooks.ts";

/** The magenta source's binding for the `hook` capability (spec §8). */
export const hookMagentaMagnet: CapabilitySourceMagnet = {
	kind: "hook",
	source: "magenta",
	isDefault: true,
	build: () => new HookProvider(),
};
