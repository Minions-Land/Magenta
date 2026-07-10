import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { BASH_TOOL_DESCRIPTION, type BashExecuteOptions, bashSchema, createBashExecute } from "./bash.ts";

export class HcpMagnet {
	static readonly module = "tools/bash";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		if (context.settings === undefined) return undefined;
		return new HcpMagnet(context.cwd ?? context.repoRoot, context.settings as BashExecuteOptions);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(cwd: string, options: BashExecuteOptions) {
		this.tool = createNativeTool(
			{
				name: "bash",
				description: BASH_TOOL_DESCRIPTION,
				parameters: bashSchema,
				createExecute: (boundCwd) => createBashExecute(boundCwd, options),
				renderKind: "shell-output",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
