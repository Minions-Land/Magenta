import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { SessionGroundingMemoryProvider } from "./session-grounding.ts";

/**
 * The magenta source's binding for the `memory` capability (spec §8).
 * 按照规范§2：裸 class，不声明名义实现、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "memory";
	static readonly kind = "memory";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "capability:memory";
	private readonly capabilityKind: string;
	private readonly name: string;
	readonly source: string;
	readonly hotSwappable: boolean;
	private readonly provider: SessionGroundingMemoryProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "memory";
		this.name = context.name ?? "memory";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new SessionGroundingMemoryProvider({ workspaceRoot: context.repoRoot });
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
