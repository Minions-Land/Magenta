import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createWriteExecute, type WriteToolOptions, writeSchema } from "./write.ts";

export class HcpMagnet {
	static readonly module = "tools/write";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(
			context.cwd ?? context.repoRoot,
			context.settings as WriteToolOptions | undefined,
			context.description,
		);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(
		cwd: string,
		options?: WriteToolOptions,
		description = "Write content to a file, creating parent directories as needed.",
	) {
		this.tool = createNativeTool(
			{
				name: "write",
				description,
				parameters: writeSchema,
				createExecute: (boundCwd) => createWriteExecute(boundCwd, options),
				renderKind: "file-write",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
