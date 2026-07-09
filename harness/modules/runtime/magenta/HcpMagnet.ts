import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { createCapabilityServer } from "../../../harness-component-protocol/server/capability-server.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import type { ProcessExecInput, ScriptRuntimeInput } from "../HcpServer.ts";
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
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "runtime";
	static readonly kind = "runtime";
	static readonly slotName = "process";
	static readonly source = "magenta";
	static readonly isDefault = true;
	static readonly defaultSlotNames = ["script-runtimes"] as const;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "runtime";
		const name = context.name ?? "process";
		const source = context.source ?? "magenta";
		let instance: unknown;

		if (name === "process") {
			const provider = new ProcessRuntimeProvider();
			instance = createCapabilityServer({
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
		} else if (name === "script-runtimes") {
			const provider = new ScriptRuntimeProvider();
			instance = createCapabilityServer({
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
		} else {
			throw new Error(`unknown magenta runtime capability: ${name}`);
		}

		// For multi-slot capabilities like runtime, the target must include the slot name
		// to avoid collisions: capability:runtime:process vs capability:runtime:script-runtimes
		const targetSuffix = name === kind ? kind : `${kind}:${name}`;

		super({
			descriptor: {
				target: `capability:${targetSuffix}`,
				kind: kind,
				name: name,
				implementation: `capability:${kind}`,
				description: `Runtime capability ${name}`,
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}

function runtimeNameFromTarget(target: string): string {
	const match = target.match(/^runtime:\/\/([^/]+)/);
	return match ? match[1] : "shell";
}
