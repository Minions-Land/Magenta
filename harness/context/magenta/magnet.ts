import type { CapabilitySourceMagnet } from "../../assembly/magnet/source-magnet.ts";
import { ContextProvider } from "./context.ts";

/** The magenta source's binding for the `context` capability (spec §8). */
export const contextMagentaMagnet: CapabilitySourceMagnet = {
	kind: "context",
	source: "magenta",
	isDefault: true,
	build: () => new ContextProvider({}),
};
