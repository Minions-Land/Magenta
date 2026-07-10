import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { createPackageToolProduct, type PackageToolBuildSettings } from "./package-tool.ts";

type HcpMagnettoolproduct = {
	readonly kind: string;
	toTool(): AgentTool;
	close?(): void | Promise<void>;
};

/** Source connector for package/runtime tool products assembled by Magenta. */
export class HcpMagnet {
	static readonly module = "tools";
	static readonly kind = "tool";
	static readonly source = "descriptor";
	static async build(context: HcpMagnetBuildContext) {
		if (HcpMagnetistoolproduct(context.settings)) return new HcpMagnet(context.settings);
		if (HcpMagnetisprebuiltpackagesettings(context.settings)) return new HcpMagnet(context.settings.product);
		if (!HcpMagnetispackagesettings(context.settings)) {
			throw new Error("tools:descriptor requires a Tool product or one Package tool component setting");
		}
		const result = await createPackageToolProduct({
			component: context.settings.component,
			mcp: context.settings.mcp,
			context: {
				repoRoot: context.repoRoot,
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

	async dispose(): Promise<void> {
		await this.product.close?.();
	}
}

function HcpMagnetisprebuiltpackagesettings(
	value: unknown,
): value is PackageToolBuildSettings & { product: HcpMagnettoolproduct } {
	return HcpMagnetispackagesettings(value) && HcpMagnetistoolproduct(value.product);
}

function HcpMagnetistoolproduct(value: unknown): value is HcpMagnettoolproduct {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { kind?: unknown }).kind === "string" &&
		typeof (value as { toTool?: unknown }).toTool === "function"
	);
}

function HcpMagnetispackagesettings(value: unknown): value is PackageToolBuildSettings {
	return value !== null && typeof value === "object" && "component" in value && "componentMap" in value;
}
