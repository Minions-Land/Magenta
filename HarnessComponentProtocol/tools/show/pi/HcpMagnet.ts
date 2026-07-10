import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createShowExecute, showSchema } from "./show.ts";

export class HcpMagnet {
	static readonly module = "tools/show";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context.cwd ?? context.repoRoot, context.description);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(cwd: string, description = "Display local files or remote URLs in the host preview surface.") {
		this.tool = createNativeTool(
			{
				name: "show",
				description,
				parameters: showSchema,
				createExecute: (boundCwd) => createShowExecute(boundCwd),
				renderKind: "file-preview",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
