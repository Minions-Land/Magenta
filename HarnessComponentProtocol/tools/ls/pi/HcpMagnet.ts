import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createLsExecute, type LsToolOptions, lsSchema } from "./ls.ts";

export class HcpMagnet {
	static readonly module = "tools/ls";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(
			context.cwd ?? context.repoRoot,
			context.settings as LsToolOptions | undefined,
			context.description,
		);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(cwd: string, options?: LsToolOptions, description = "List directory entries.") {
		this.tool = createNativeTool(
			{
				name: "ls",
				description,
				parameters: lsSchema,
				createExecute: (boundCwd) => createLsExecute(boundCwd, options),
				renderKind: "directory-list",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
