import type { CapabilitySourceMagnet } from "../../../hcp-contract/hcp-magnet.ts";
import { ProcessRuntimeProvider } from "./process-runtime.ts";
import { ScriptRuntimeProvider } from "./script-runtime.ts";

/**
 * The magenta source's binding for the `runtime` capability family (spec §8).
 *
 * One source builder serves both runtime slots, dispatching on `context.name`:
 * `runtime:process` and `runtime:script-runtimes`. `defaultSlotNames` records
 * the extra slot it is the default for, so the derived default map covers both.
 */
export const runtimeMagentaMagnet: CapabilitySourceMagnet = {
	module: "runtime",
	kind: "runtime",
	name: "process",
	source: "magenta",
	isDefault: true,
	defaultSlotNames: ["script-runtimes"],
	build: (context) => {
		if (context.name === "process") return new ProcessRuntimeProvider();
		if (context.name === "script-runtimes") return new ScriptRuntimeProvider();
		throw new Error(`unknown magenta runtime capability: ${context.name}`);
	},
};
