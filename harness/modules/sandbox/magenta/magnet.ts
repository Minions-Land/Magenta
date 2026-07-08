import { fileURLToPath } from "node:url";
import type { CapabilitySourceMagnet } from "../../../hcp-contract/hcp-magnet.ts";
import { loadSandboxProviderFromPack } from "./sandbox.ts";

/** The magenta source's binding for the `sandbox` capability (spec §8). */
export const sandboxMagentaMagnet: CapabilitySourceMagnet = {
	module: "sandbox",
	kind: "sandbox",
	source: "magenta",
	isDefault: true,
	build: (context) =>
		loadSandboxProviderFromPack(context.descriptorPath ?? fileURLToPath(new URL("../sandbox.toml", import.meta.url))),
};
