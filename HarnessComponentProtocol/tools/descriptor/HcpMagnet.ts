import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { createPackageToolProduct, type PackageToolBuildSettings } from "./package-tool.ts";

type HcpMagnettoolproduct = {
	readonly kind: string;
	toTool(): AgentTool;
};

/** Source connector for package/runtime tool products assembled by Magenta. */
export class HcpMagnet {
	static readonly module = "tools";
	static readonly kind = "tool";
	static readonly source = "descriptor";
	static async build(context: HcpMagnetBuildContext) {
		if (!HcpMagnetispackagesettings(context.settings)) {
			throw new Error("tools:descriptor requires one package tool component setting");
		}
		const result = await createPackageToolProduct({
			component: context.settings.component,
			mcp: context.settings.mcp,
			context: {
				repoRoot: context.repoRoot,
				packagesRoot: context.packagesRoot,
				components: context.settings.components,
				componentMap: context.settings.componentMap,
				resolveCapability: context.resolveCapability ?? (() => undefined),
			},
		});
		context.settings.diagnostics.push(...result.diagnostics);
		return result.product ? new HcpMagnet(result.product) : undefined;
	}

	readonly source = "descriptor";
	readonly kind: string;
	readonly product: HcpMagnettoolproduct;

	constructor(product: HcpMagnettoolproduct) {
		this.product = product;
		this.kind = product.kind;
	}

	toTool(): AgentTool {
		return this.product.toTool();
	}
}

function HcpMagnetispackagesettings(value: unknown): value is PackageToolBuildSettings {
	return value !== null && typeof value === "object" && "component" in value && "componentMap" in value;
}
