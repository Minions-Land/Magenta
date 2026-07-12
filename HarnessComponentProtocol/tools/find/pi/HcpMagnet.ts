import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { getEmbeddedToolPath } from "../../../_magenta/utils/pi/embedded-tools.ts";
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
				// The default find implementation shells out to fd, resolved through the
				// ensureTool dep. Previously this Magnet omitted deps entirely, so
				// createFindExecute always hit the "no ensureTool dependency was provided"
				// guard and every HCP-resolved find call failed — even though fd ships
				// embedded. Wire the embedded fd resolver so HCP find works out of the box.
				createExecute: (boundCwd) =>
					createFindExecute(boundCwd, options, {
						ensureTool: async (tool: string) => getEmbeddedToolPath(tool as "fd" | "rg") ?? undefined,
					}),
				renderKind: "file-search",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
