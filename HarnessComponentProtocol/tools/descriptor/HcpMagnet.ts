import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { McpTool, type McpToolOptions } from "../../_magenta/mcp/tool.ts";
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
		if (HcpMagnetismcpsettings(context.settings)) return new HcpMagnet(new McpTool(context.settings.mcp));
		if (!HcpMagnetispackagesettings(context.settings)) {
			throw new Error("tools:descriptor requires MCP discovery settings or one Package tool setting");
		}
		const result = await createPackageToolProduct({
			component: context.settings.component,
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

function HcpMagnetismcpsettings(value: unknown): value is { mcp: McpToolOptions } {
	if (value === null || typeof value !== "object") return false;
	const mcp = (value as { mcp?: unknown }).mcp;
	if (mcp === null || typeof mcp !== "object") return false;
	const settings = mcp as Partial<McpToolOptions>;
	return (
		settings.connection !== undefined &&
		typeof settings.connection.retainTool === "function" &&
		settings.tool !== undefined &&
		typeof settings.tool.name === "string"
	);
}

function HcpMagnetispackagesettings(value: unknown): value is PackageToolBuildSettings {
	return value !== null && typeof value === "object" && "component" in value && "componentMap" in value;
}
