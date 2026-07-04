import type { CapabilitySourceMagnet } from "../../assembly/magnet/source-magnet.ts";
import { PolicyProvider } from "./policy.ts";

/** The magenta source's binding for the `policy` capability (spec §8). */
export const policyMagentaMagnet: CapabilitySourceMagnet = {
	kind: "policy",
	source: "magenta",
	isDefault: true,
	build: () => new PolicyProvider(),
};
