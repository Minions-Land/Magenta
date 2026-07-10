import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createFindExecute, type FindToolOptions, findSchema } from "./find.ts";

export class HcpMagnet {
	static readonly module = "tools/find";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(
			context.cwd ?? context.repoRoot,
			context.settings as FindToolOptions | undefined,
			context.description,
		);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(cwd: string, options?: FindToolOptions, description = "Find files matching a glob pattern.") {
		this.tool = createNativeTool(
			{
				name: "find",
				description,
				parameters: findSchema,
				createExecute: (boundCwd) => createFindExecute(boundCwd, options),
				renderKind: "file-search",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
