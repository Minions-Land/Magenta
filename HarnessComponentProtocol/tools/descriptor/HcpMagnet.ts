import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { type CreateMcpToolsOptions, discoverMcpTools, McpTool, type McpToolOptions } from "../../_magenta/mcp/tool.ts";
import { HcpClientbuildpackagetoolproducts, type HcpClientpackagetoolbuildsettings } from "./package-tool.ts";

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
		if (HcpMagnetismcpdiscoverysettings(context.settings)) {
			return HcpMagnetbuildmcp(context.settings.mcp);
		}
		if (HcpMagnetismcpsettings(context.settings)) return HcpMagnetfrommcp(context.settings.mcp);
		if (!HcpMagnetispackagesettings(context.settings)) {
			throw new Error("tools:descriptor requires MCP discovery settings or one Package tool setting");
		}
		const packageContext = {
			repoRoot: context.repoRoot,
			cacheRoot: context.cacheRoot,
			components: context.settings.components,
			componentMap: context.settings.componentMap,
			resolveCapability: context.resolveCapability ?? (() => undefined),
		};
		const products = await HcpClientbuildpackagetoolproducts(context.settings, packageContext);
		const magnets = products.map((product) => new HcpMagnet(product));
		if (magnets.length === 0) return undefined;
		return magnets.length === 1 ? magnets[0] : magnets;
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

function HcpMagnetfrommcp(options: McpToolOptions): HcpMagnet {
	return new HcpMagnet(new McpTool({ ...options, terminalOnLastRelease: true }));
}

async function HcpMagnetbuildmcp(options: CreateMcpToolsOptions): Promise<HcpMagnet | HcpMagnet[] | undefined> {
	const { connection, tools } = await discoverMcpTools(options);
	const magnets: HcpMagnet[] = [];
	try {
		for (const tool of tools) {
			magnets.push(HcpMagnetfrommcp({ connection, tool, namePrefix: options.namePrefix }));
		}
		if (magnets.length === 0) {
			await connection.close();
			return undefined;
		}
		return magnets.length === 1 ? magnets[0] : magnets;
	} catch (error) {
		await Promise.allSettled(magnets.map((magnet) => magnet.dispose()));
		try {
			await connection.close();
		} catch {
			// Preserve the Source construction failure after best-effort terminal cleanup.
		}
		throw error;
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

function HcpMagnetismcpdiscoverysettings(value: unknown): value is { mcp: CreateMcpToolsOptions } {
	if (value === null || typeof value !== "object") return false;
	const mcp = (value as { mcp?: unknown }).mcp;
	if (mcp === null || typeof mcp !== "object") return false;
	const settings = mcp as Partial<CreateMcpToolsOptions>;
	return typeof settings.serverName === "string" && settings.client !== undefined;
}

function HcpMagnetispackagesettings(value: unknown): value is HcpClientpackagetoolbuildsettings {
	return value !== null && typeof value === "object" && "component" in value && "componentMap" in value;
}
