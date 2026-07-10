import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { PolicyProvider } from "./policy.ts";

/**
 * The magenta source's binding for the `policy` capability (spec §8).
 * 按照规范§2：裸 class，不声明名义实现、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "policy";
	static readonly kind = "policy";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "native";
	readonly hotSwappable: boolean;
	private readonly provider: PolicyProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new PolicyProvider();
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: "policy",
			name: "policy",
			source: "magenta",
			instance: this.provider,
		};
	}
}
