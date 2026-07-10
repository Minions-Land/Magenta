import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import type { ProcessRuntimeProvider as ProcessRuntimeProviderShape } from "../HcpServer.ts";
import { ProcessRuntimeProvider } from "./process-runtime.ts";
import { ScriptRuntimeProvider } from "./script-runtime.ts";

/**
 * The magenta source's binding for the `runtime` capability family (spec §8).
 * 按照规范§2：裸 class，不声明名义实现、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "runtime";
	static readonly kind = "runtime";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "native";
	readonly source: string;
	readonly hotSwappable: boolean;
	private readonly capabilityKind: string;
	private readonly slotName: string;
	private readonly provider: ProcessRuntimeProvider | ScriptRuntimeProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "runtime";
		const name = context.name ?? "process";
		this.slotName = name;
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;

		if (name === "process") {
			this.provider = new ProcessRuntimeProvider();
		} else if (name === "script-runtimes") {
			const processRuntime = context.resolveCapability?.<ProcessRuntimeProviderShape>("runtime:process");
			if (!processRuntime) {
				throw new Error("runtime:script-runtimes requires selected capability runtime:process");
			}
			this.provider = new ScriptRuntimeProvider(processRuntime.exec.bind(processRuntime));
		} else {
			throw new Error(`unknown magenta runtime capability: ${name}`);
		}
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.slotName,
			source: this.source,
			instance: this.provider,
		};
	}
}
