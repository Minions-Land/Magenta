import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { SubAgentRuntime, type SubAgentRuntimeSettings } from "./runtime.ts";

export class HcpMagnet {
	static readonly module = "tools/sub-agent";
	static readonly kind = "tool";
	static readonly source = "magenta";

	static build(context: HcpMagnetBuildContext): HcpMagnet | undefined {
		const settings = context.settings as SubAgentRuntimeSettings | undefined;
		if (settings === undefined) return undefined;
		if (
			!settings.cwd ||
			!settings.workDirRoot ||
			!settings.backgroundEvents ||
			typeof settings.resolveAgentInvocation !== "function" ||
			typeof settings.registerReturn !== "function" ||
			typeof settings.cancelReturn !== "function"
		) {
			throw new Error(
				"tools/sub-agent requires cwd, workDirRoot, backgroundEvents, process resolution, and external activation host settings",
			);
		}
		return new HcpMagnet(settings);
	}

	readonly kind = "native";
	readonly source = "magenta";
	readonly hotSwappable = false;
	private readonly runtime: SubAgentRuntime;

	constructor(settings: SubAgentRuntimeSettings) {
		this.runtime = new SubAgentRuntime(settings);
		settings.onRuntime?.(this.runtime);
	}

	toTool(): AgentTool {
		return this.runtime.toTool();
	}

	dispose(): void {
		this.runtime.dispose();
	}
}
