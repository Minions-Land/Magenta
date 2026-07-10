import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createTodoTool, type TodoToolOptions } from "./todo.ts";

export class HcpMagnet {
	static readonly module = "tools/todo";
	static readonly kind = "tool";
	static readonly source = "pi";

	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context.cwd ?? context.repoRoot, context.settings as TodoToolOptions | undefined);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool: AgentTool;

	constructor(cwd: string, options?: TodoToolOptions) {
		this.tool = createTodoTool(cwd, options);
	}

	toTool(): AgentTool {
		return this.tool;
	}
}
