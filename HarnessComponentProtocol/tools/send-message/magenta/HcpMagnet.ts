import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { SendMessageRuntime, type SendMessageRuntimeSettings } from "./runtime.ts";

export class HcpMagnet {
	static readonly module = "tools/send-message";
	static readonly kind = "tool";
	static readonly source = "magenta";

	static build(context: HcpMagnetBuildContext): HcpMagnet | undefined {
		const settings = context.settings as SendMessageRuntimeSettings | undefined;
		if (settings === undefined) return undefined;
		if (!settings.dbPath || typeof settings.getSessionId !== "function") {
			throw new Error("tools/send-message requires dbPath and getSessionId host settings");
		}
		return new HcpMagnet(settings);
	}

	readonly kind = "native";
	readonly source = "magenta";
	readonly hotSwappable = false;
	private readonly runtime: SendMessageRuntime;

	constructor(settings: SendMessageRuntimeSettings) {
		this.runtime = new SendMessageRuntime(settings);
		settings.onRuntime?.(this.runtime);
	}

	toTool(): AgentTool {
		return this.runtime.toTool();
	}

	dispose(): void {
		this.runtime.dispose();
	}
}
