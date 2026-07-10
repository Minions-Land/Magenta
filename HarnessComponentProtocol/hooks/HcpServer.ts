import type { HcpMagnetBinding } from "../.HCP/HcpMagnetTypes.ts";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";
import { HcpClienttargetname } from "../HcpClient.ts";

export class HcpServer {
	readonly moduleName = "hooks";
	readonly description = "Harness lifecycle hook discovery and execution.";

	private binding(magnet: { toCapability?(): unknown }): HcpMagnetBinding<HookProvider> {
		return magnet.toCapability?.() as HcpMagnetBinding<HookProvider>;
	}

	describeSource(
		_selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
	): HcpServerDescription {
		const binding = this.binding(magnet);
		return {
			target: "capability:hook",
			kind: "hook",
			ops: ["discover", "list", "describe", "run", "call"],
			description: this.description,
			metadata: {
				name: binding.name,
				source: binding.source,
				implementation: "native-ts",
				hotSwappable: magnet.hotSwappable ?? false,
			},
		};
	}

	sourceAddresses(_selector: string, magnet: { toCapability?(): unknown }): string[] {
		return ["capability:hook", ...this.binding(magnet).instance.discover().targets];
	}

	callSource(_selector: string, magnet: { toCapability?(): unknown }, request: HcpServerRequest): unknown {
		const provider = this.binding(magnet).instance;
		switch (request.op || "run") {
			case "discover":
			case "list":
				return provider.discover();
			case "describe":
				return provider.describeHook(HcpClienttargetname(request.target));
			case "run":
			case "call":
				return provider.run(HcpClienttargetname(request.target), request.input);
			default:
				throw new Error(`Unknown operation: ${request.op} for hook capability at ${request.target}`);
		}
	}
}

export type HookDescriptor = {
	name: string;
	target: string;
	path?: string;
	description: string;
};

export type HookResult = {
	hook: string;
	status: "ok" | "no_op";
	return_mode?: string;
	actions?: unknown[];
	data?: unknown;
	reason?: string;
};

export type HookDiscoverResult = {
	provider: "hooks";
	targets: string[];
	lifecycle_targets: string[];
	hooks: HookDescriptor[];
};

/**
 * The hooks capability surface consumed by the agent loop. This is the
 * injection surface: the loop calls the source-selected provider instead of
 * statically importing hooks, so the assembly layer decides which source
 * (magenta, ...) supplies the behavior.
 *
 * This type contains only business logic. The real module HcpServer above owns
 * HCP routing; the provider does not construct or register HCP entities.
 */
export type HookProvider = {
	discover(): HookDiscoverResult;
	describeHook(name: string): HookDescriptor;
	run(name: string, input: unknown): HookResult | unknown;
};
