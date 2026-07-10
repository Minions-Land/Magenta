import { fileURLToPath } from "node:url";
import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { loadSandboxProviderFromPackSync, type SandboxProvider } from "./sandbox.ts";

/**
 * The magenta source's binding for the `sandbox` capability (spec §8).
 * 按照规范§2 + 头号铁律：裸 class，不继承任何基类。名字 = Hcp + Magnet。
 */
export class HcpMagnet {
	static readonly module = "sandbox";
	static readonly kind = "sandbox";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "capability:sandbox";
	readonly hotSwappable: boolean;
	private readonly capabilityKind: string;
	private readonly name: string;
	readonly source: string;
	private readonly instance: SandboxProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "sandbox";
		this.name = context.name ?? "sandbox";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.instance = loadSandboxProviderFromPackSync(
			context.descriptorPath ?? fileURLToPath(new URL("../sandbox.toml", import.meta.url)),
		);
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.name,
			source: this.source,
			instance: this.instance,
		};
	}
}
