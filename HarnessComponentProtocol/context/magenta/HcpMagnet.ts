import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { ContextProvider } from "./context.ts";

/**
 * The magenta source's binding for the `context` capability (spec §8).
 * 按照规范§2：裸 class，不声明名义实现、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "context";
	static readonly kind = "context";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "capability:context";
	private readonly capabilityKind: string;
	private readonly name: string;
	readonly source: string;
	readonly hotSwappable: boolean;
	private readonly provider: ContextProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "context";
		this.name = context.name ?? "context";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new ContextProvider({});
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.name,
			source: this.source,
			instance: this.provider,
		};
	}
}
