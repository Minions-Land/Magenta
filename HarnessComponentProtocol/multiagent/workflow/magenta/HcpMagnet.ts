import type { HcpMagnetBinding, HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { MultiAgentOrchestrator } from "./orchestrator.ts";
import type { WorkerInvocationResolver } from "./worker.ts";

function HcpMagnetworkerinvocation(settings: unknown): WorkerInvocationResolver | undefined {
	if (!settings || typeof settings !== "object") return undefined;
	const resolver = (settings as { resolveWorkerInvocation?: unknown }).resolveWorkerInvocation;
	return typeof resolver === "function" ? (resolver as WorkerInvocationResolver) : undefined;
}

/**
 * The magenta source's binding for the `multiagent` capability (spec §8).
 * 按照规范§2：裸 class，不声明名义实现、不继承任何基类。
 */
export class HcpMagnet {
	static readonly module = "multiagent";
	static readonly kind = "multiagent";
	static readonly source = "magenta";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(context);
	}

	readonly kind = "native";
	readonly source: string;
	readonly hotSwappable: boolean;
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly provider: MultiAgentOrchestrator;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "multiagent";
		this.name = context.name ?? "multiagent";
		this.source = context.source ?? "magenta";
		this.hotSwappable = context.hotSwappable ?? false;
		this.provider = new MultiAgentOrchestrator({
			cwd: context.repoRoot,
			resolveWorkerInvocation: HcpMagnetworkerinvocation(context.settings),
		});
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.name,
			source: this.source,
			instance: this.provider,
		};
	}
}
