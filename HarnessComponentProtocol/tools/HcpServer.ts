import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";

type HcpMagnettool = {
	readonly kind: string;
	readonly source?: string;
	toTool(): AgentTool;
};

export class HcpServer {
	readonly moduleName = "tools";
	readonly description = "Model-callable harness tools.";

	describeSource(selector: string, magnet: HcpMagnettool): HcpServerDescription {
		const tool = magnet.toTool();
		return {
			target: selector.startsWith("tool:") ? selector : `tool:${tool.name}`,
			kind: "tool",
			ops: ["describe", "health", "resolve"],
			description: tool.description,
			metadata: {
				name: tool.name,
				implementation: magnet.kind,
				source: magnet.source,
				...(tool.provenance ? { provenance: tool.provenance } : {}),
			},
		};
	}

	sourceAddresses(selector: string): string[] {
		return [selector];
	}

	callSource(selector: string, magnet: HcpMagnettool, request: HcpServerRequest): unknown {
		switch (request.op) {
			case "describe":
				return this.describeSource(selector, magnet);
			case "health":
				return { status: "ok", target: selector, implementation: magnet.kind };
			case "toTool":
			case "resolve":
			case "instance":
				return magnet.toTool();
			default:
				throw new Error(`Tools module ${selector}: unsupported management op "${request.op}"`);
		}
	}
}
