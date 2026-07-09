import type { CapabilitySourceMagnet } from "../../../hcp-client/HcpMagnetTypes.ts";
import { createCapabilityServer } from "../../../hcp-client/server/capability-server.ts";
import type { ProcessExecInput, ScriptRuntimeInput } from "../contract.ts";
import { ProcessRuntimeProvider } from "./process-runtime.ts";
import { SCRIPT_RUNTIME_SPECS, ScriptRuntimeProvider } from "./script-runtime.ts";

/**
 * The magenta source's binding for the `runtime` capability family (spec §8).
 *
 * One source builder serves both runtime slots, dispatching on `context.name`:
 * `runtime:process` and `runtime:script-runtimes`. `defaultSlotNames` records
 * the extra slot it is the default for, so the derived default map covers both.
 *
 * Wraps runtime providers (pure business logic) in unified HcpServer adapters,
 * making HcpServer an explicit layer rather than hand-written in each provider.
 */
export const runtimeMagentaMagnet: CapabilitySourceMagnet = {
	module: "runtime",
	kind: "runtime",
	name: "process",
	source: "magenta",
	isDefault: true,
	defaultSlotNames: ["script-runtimes"],
	build: (context) => {
		if (context.name === "process") {
			const provider = new ProcessRuntimeProvider();
			return createCapabilityServer({
				kind: "runtime",
				target: "runtime://process",
				description: "Spawn a local process with Magenta portable sandbox guardrails.",
				provider,
				operations: {
					discover: (p) => p.discover(),
					exec: (p, req) => p.exec(req.input as ProcessExecInput),
					call: (p, req) => p.exec(req.input as ProcessExecInput),
					policy: (p) => p.policyStatus(),
					status: (p) => p.policyStatus(),
					health: (p) => p.health(),
				},
				metadata: {
					implementation: "native-ts",
					source: "magenta",
					origin: "magenta1-general-harness",
					osEnforcement: false,
				},
			});
		}

		if (context.name === "script-runtimes") {
			const provider = new ScriptRuntimeProvider();
			return createCapabilityServer({
				kind: "runtime",
				target: "runtime://{shell,python,node,r,julia}",
				description: "Script runtime wrappers compiled to runtime://process.",
				provider,
				operations: {
					discover: (p) => p.discover(),
					list: (p) => p.discover(),
					describe: (p, req) => {
						const name = runtimeNameFromTarget(req.target);
						return p.describeRuntime(name);
					},
					exec: (p, req) => {
						const name = runtimeNameFromTarget(req.target);
						return p.execRuntime(name, req.input as ScriptRuntimeInput);
					},
					call: (p, req) => {
						const name = runtimeNameFromTarget(req.target);
						return p.execRuntime(name, req.input as ScriptRuntimeInput);
					},
					run: (p, req) => {
						const name = runtimeNameFromTarget(req.target);
						return p.execRuntime(name, req.input as ScriptRuntimeInput);
					},
				},
				metadata: {
					implementation: "native-ts",
					source: "magenta",
					origin: "magenta1-general-harness",
					compiledTo: "runtime://process",
					runtimes: SCRIPT_RUNTIME_SPECS.map((s) => s.name),
				},
			});
		}

		throw new Error(`unknown magenta runtime capability: ${context.name}`);
	},
};

function runtimeNameFromTarget(target: string): string {
	const match = target.match(/^runtime:\/\/([^/]+)/);
	return match ? match[1] : "shell";
}
