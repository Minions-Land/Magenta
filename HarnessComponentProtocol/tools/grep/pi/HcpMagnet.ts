import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { createNativeTool } from "../../native-tool.ts";
import { createGrepExecute, GREP_DESCRIPTION, type GrepToolOptions, grepSchema } from "./grep.ts";

export class HcpMagnet {
	static readonly module = "tools/grep";
	static readonly kind = "tool";
	static readonly source = "pi";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context.cwd ?? context.repoRoot, context.settings as GrepToolOptions | undefined);
	}

	readonly kind = "native";
	readonly source = "pi";
	private readonly tool;

	constructor(cwd: string, options?: GrepToolOptions) {
		this.tool = createNativeTool(
			{
				name: "grep",
				description: GREP_DESCRIPTION,
				parameters: grepSchema,
				createExecute: (boundCwd) => createGrepExecute(boundCwd, options),
				renderKind: "pattern-search",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
