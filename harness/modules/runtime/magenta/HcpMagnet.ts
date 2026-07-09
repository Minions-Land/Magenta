import type {
	HcpMagnetBinding,
} from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpServerDescription,
	HcpServerRequest,
	HcpMagnetBuildContext,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import type { ProcessExecInput, ScriptRuntimeInput } from "../HcpServer.ts";
import { ProcessRuntimeProvider } from "./process-runtime.ts";
import { SCRIPT_RUNTIME_SPECS, ScriptRuntimeProvider } from "./script-runtime.ts";

/**
 * The magenta source's binding for the `runtime` capability family (spec §8).
 * 按照规范§2：裸 class，不 implements、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "runtime";
	static readonly kind = "runtime";
	static readonly slotName = "process";
	static readonly source = "magenta";
	static readonly isDefault = true;
	static readonly defaultSlotNames = ["script-runtimes"] as const;

	readonly kind = "native";
	private readonly slotName: string;
	private readonly provider: ProcessRuntimeProvider | ScriptRuntimeProvider;
	private readonly target: string;
	private readonly description: string;
	private readonly metadata: Record<string, unknown>;

	constructor(context: HcpMagnetBuildContext) {
		const name = context.name ?? "process";
		this.slotName = name;

		if (name === "process") {
			this.provider = new ProcessRuntimeProvider();
			this.target = "runtime://process";
			this.description = "Spawn a local process with Magenta portable sandbox guardrails.";
			this.metadata = {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
				osEnforcement: false,
			};
		} else if (name === "script-runtimes") {
			this.provider = new ScriptRuntimeProvider();
			this.target = "runtime://{shell,python,node,r,julia}";
			this.description = "Script runtime wrappers compiled to runtime://process.";
			this.metadata = {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
				compiledTo: "runtime://process",
				runtimes: SCRIPT_RUNTIME_SPECS.map((s) => s.name),
			};
		} else {
			throw new Error(`unknown magenta runtime capability: ${name}`);
		}
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: "runtime",
			name: this.slotName,
			source: "magenta",
			instance: this.provider,
		};
	}

	toHcpServer() {
		const targetSuffix = this.slotName === "runtime" ? "runtime" : `runtime:${this.slotName}`;
		return {
			describe: (): HcpServerDescription => ({
				target: `capability:${targetSuffix}`,
				kind: "runtime",
				ops: this.slotName === "process"
					? ["discover", "exec", "call", "policy", "status", "health"]
					: ["discover", "list", "describe", "exec", "call", "run"],
				description: this.description,
				metadata: this.metadata,
			}),
			call: async (request: HcpServerRequest): Promise<unknown> => {
				const op = request.op || "call";

				if (this.slotName === "process") {
					const provider = this.provider as ProcessRuntimeProvider;
					switch (op) {
						case "discover":
							return provider.discover();
						case "exec":
						case "call":
							return provider.exec(request.input as ProcessExecInput);
						case "policy":
						case "status":
							return provider.policyStatus();
						case "health":
							return provider.health();
						default:
							throw new Error(`Unknown operation: ${op} for runtime:process`);
					}
				} else {
					const provider = this.provider as ScriptRuntimeProvider;
					const runtimeName = this.extractRuntimeName(request.target);
					switch (op) {
						case "discover":
						case "list":
							return provider.discover();
						case "describe":
							return provider.describeRuntime(runtimeName);
						case "exec":
						case "call":
						case "run":
							return provider.execRuntime(runtimeName, request.input as ScriptRuntimeInput);
						default:
							throw new Error(`Unknown operation: ${op} for runtime:script-runtimes`);
					}
				}
			},
			instance: <T = unknown>(_selector?: string): T | undefined => this.provider as unknown as T,
		};
	}

	private extractRuntimeName(target: string): string {
		const match = target.match(/^runtime:\/\/([^/]+)/);
		return match ? match[1] : "shell";
	}
}
