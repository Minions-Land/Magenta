import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { MultiagentController, type MultiagentRuntimeSettings } from "./multiagent.ts";

export class HcpMagnet {
	static readonly module = "tools/multiagent";
	static readonly kind = "tool";
	static readonly source = "magenta";

	static build(context: HcpMagnetBuildContext): HcpMagnet | undefined {
		const settings = context.settings as MultiagentRuntimeSettings | undefined;
		if (settings === undefined) return undefined;
		if (
			!settings.cwd ||
			!settings.agentDir ||
			!settings.peerMessageDbPath ||
			!settings.registryPath ||
			!settings.parentSessionId ||
			!settings.backgroundEvents ||
			typeof settings.resolveAgentInvocation !== "function" ||
			typeof settings.createChildSession !== "function" ||
			typeof settings.getMailboxSupport !== "function"
		) {
			throw new Error(
				"tools/multiagent requires Main Session identity/paths, background presentation, process resolution, Session creation, and Mailbox support settings",
			);
		}
		return new HcpMagnet(settings);
	}

	readonly kind = "native";
	readonly source = "magenta";
	readonly hotSwappable = false;
	private readonly runtime: MultiagentController;

	constructor(settings: MultiagentRuntimeSettings) {
		this.runtime = new MultiagentController(settings);
		settings.onRuntime?.(this.runtime);
	}

	toTool(): AgentTool {
		return this.runtime.createToolDefinition();
	}

	dispose(): Promise<void> {
		return this.runtime.dispose();
	}
}
