import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createToolSearchTool, type ToolSearchOptions } from "./tool-search.ts";

export class HcpMagnet {
	static readonly module = "tools/tool-search";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		if (!HcpMagnetisoptions(context.settings)) return undefined;
		return new HcpMagnet(createToolSearchTool(context.settings));
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool: AgentTool;

	constructor(tool: AgentTool) {
		this.tool = tool;
	}

	toTool(): AgentTool {
		return this.tool;
	}
}

function HcpMagnetisoptions(value: unknown): value is ToolSearchOptions {
	return value !== null && typeof value === "object" && "manifest" in value && "onActivate" in value;
}
