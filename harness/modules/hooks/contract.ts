export interface HookDescriptor {
	name: string;
	target: string;
	path?: string;
	description: string;
}

export interface HookResult {
	hook: string;
	status: "ok" | "no_op";
	return_mode?: string;
	actions?: unknown[];
	data?: unknown;
	reason?: string;
}

export interface HookDiscoverResult {
	provider: "hooks";
	targets: string[];
	lifecycle_targets: string[];
	hooks: HookDescriptor[];
}

/**
 * The hooks capability surface consumed by the agent loop. This is the
 * injection contract: the loop calls the source-selected provider instead of
 * statically importing hooks, so the assembly layer decides which source
 * (magenta, ...) supplies the behavior.
 *
 * Note: This interface contains only business logic. Conversion to HcpServer
 * is handled by the unified capability-server adapter, not by the provider.
 */
export interface HookProvider {
	discover(): HookDiscoverResult;
	describeHook(name: string): HookDescriptor;
	run(name: string, input: unknown): HookResult | unknown;
}
