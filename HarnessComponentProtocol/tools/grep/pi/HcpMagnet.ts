import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { getEmbeddedToolPath } from "../../../_magenta/utils/pi/embedded-tools.ts";
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
		// grep shells out to ripgrep. The default resolver just returns "rg" from
		// PATH, so an HCP-resolved grep only worked when the host happened to have a
		// system rg. ripgrep ships embedded, so wire the embedded resolver by default
		// (still letting an explicit settings-provided resolver win) so grep works in
		// a clean environment without relying on PATH.
		const resolvedOptions: GrepToolOptions = {
			...options,
			resolveRipgrep: options?.resolveRipgrep ?? (async () => getEmbeddedToolPath("rg") ?? undefined),
		};
		this.tool = createNativeTool(
			{
				name: "grep",
				description: GREP_DESCRIPTION,
				parameters: grepSchema,
				createExecute: (boundCwd) => createGrepExecute(boundCwd, resolvedOptions),
				renderKind: "pattern-search",
			},
			cwd,
		);
	}

	toTool() {
		return this.tool;
	}
}
