import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createReadExecute, type ReadToolOptions, readSchema } from "./read.ts";

export class HcpMagnet {
	static readonly module = "tools/read";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(
			context.cwd ?? context.repoRoot,
			context.settings as ReadToolOptions | undefined,
			context.description,
		);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(
		cwd: string,
		options?: ReadToolOptions,
		description = "Read the contents of a file (with optional line offset/limit).",
	) {
		this.tool = createNativeTool(
			{
				name: "read",
				description,
				parameters: readSchema,
				createExecute: (boundCwd) => createReadExecute(boundCwd, options),
				renderKind: "file-content",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
