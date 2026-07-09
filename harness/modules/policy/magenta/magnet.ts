import type { CapabilitySourceMagnet } from "../../../hcp-client/contract/hcp-magnet.ts";
import { PolicyProvider } from "./policy.ts";

/** The magenta source's binding for the `policy` capability (spec §8). */
export const policyMagentaMagnet: CapabilitySourceMagnet = {
	module: "policy",
	kind: "policy",
	source: "magenta",
	isDefault: true,
	build: () => new PolicyProvider(),
};
