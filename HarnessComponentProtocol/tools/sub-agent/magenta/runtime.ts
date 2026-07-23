import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AgentSessionEvent,
	type BackgroundEventManagerPort,
	type ExternalActivationReceipt,
	SubAgentController,
	type SubAgentInvocationResolver,
	type SubAgentModelSelection,
} from "./sub-agent.ts";
import { MultiAgentOrchestrator } from "./workflow/orchestrator.ts";

export type SubAgentRuntimeSettings = {
	cwd: string;
	workDirRoot: string;
	backgroundEvents: BackgroundEventManagerPort;
	resolveAgentInvocation: SubAgentInvocationResolver;
	registerReturn: (
		eventIds: string[],
		message: { customType: string; content: string; display: boolean; details: unknown },
		delivery: "steer" | "followUp" | "nextTurn",
		receipt: ExternalActivationReceipt,
	) => void;
	cancelReturn: (eventIds: string[]) => void;
	getDefaultModel?: () => SubAgentModelSelection | undefined;
	workflowsEnabled?: boolean | (() => boolean);
	defaultTimeoutSeconds?: number;
	defaultReturnDelivery?: "steer" | "followUp" | "nextTurn";
	defaultThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	maxRetainedTerminalEvents?: number;
	onRuntime?: (runtime: SubAgentRuntime) => void;
};

export class SubAgentRuntime {
	private readonly controller: SubAgentController;
	private disposed = false;

	constructor(settings: SubAgentRuntimeSettings) {
		const workflowProvider = new MultiAgentOrchestrator({
			cwd: settings.cwd,
			// Keep workflow artifacts beside the configured sub-agent namespace,
			// never in the caller's project working tree.
			stateRoot: join(dirname(settings.workDirRoot), "workflows"),
			resolveWorkerInvocation: settings.resolveAgentInvocation,
		});
		this.controller = new SubAgentController(settings.backgroundEvents, {
			cwd: settings.cwd,
			workDirRoot: settings.workDirRoot,
			resolveAgentInvocation: settings.resolveAgentInvocation,
			registerReturn: settings.registerReturn,
			cancelReturn: settings.cancelReturn,
			getDefaultModel: settings.getDefaultModel,
			getWorkflowProvider: () => workflowProvider,
			isWorkflowEnabled: () =>
				typeof settings.workflowsEnabled === "function"
					? settings.workflowsEnabled()
					: (settings.workflowsEnabled ?? true),
			defaultTimeoutSeconds: settings.defaultTimeoutSeconds,
			defaultReturnDelivery: settings.defaultReturnDelivery,
			defaultThinking: settings.defaultThinking,
			maxRetainedFinishedEvents: settings.maxRetainedTerminalEvents,
		});
	}

	toTool(): AgentTool {
		return this.controller.createToolDefinition();
	}

	hasLiveWork(): boolean {
		return !this.disposed && this.controller.hasLiveWork();
	}

	handleAgentEvent(event: unknown): void {
		if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return;
		const type = (event as { type: string }).type;
		if (
			type !== "agent_start" &&
			type !== "tool_execution_start" &&
			type !== "tool_execution_update" &&
			type !== "tool_execution_end"
		) {
			return;
		}
		this.controller.handleAgentEvent(event as AgentSessionEvent);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.shutdown();
	}
}
