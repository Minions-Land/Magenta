import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createEditExecute, type EditToolOptions, editSchema } from "./edit.ts";

export class HcpMagnet {
	static readonly module = "tools/edit";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(
			context.cwd ?? context.repoRoot,
			context.settings as EditToolOptions | undefined,
			context.description,
		);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(
		cwd: string,
		options?: EditToolOptions,
		description = "Apply one or more targeted text replacements to a file.",
	) {
		this.tool = createNativeTool(
			{
				name: "edit",
				description,
				parameters: editSchema,
				createExecute: (boundCwd) => createEditExecute(boundCwd, options),
				renderKind: "text-edit",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
