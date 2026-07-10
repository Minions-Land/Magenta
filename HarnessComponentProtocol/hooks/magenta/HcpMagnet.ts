import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { HookProvider } from "./hooks.ts";

/**
 * The magenta source's binding for the `hook` capability (spec §8).
 * 按照规范§2：裸 class，不声明名义实现、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "hooks";
	static readonly kind = "hook";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "capability:hook";
	private readonly capabilityKind: string;
	private readonly name: string;
	readonly source: string;
	readonly hotSwappable: boolean;
	private readonly provider: HookProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "hook";
		this.name = context.name ?? "hook";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new HookProvider();
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
