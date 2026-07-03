import type { HcpServer } from "../assembly/hcp/hcp.ts";

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

export interface HookProviderContract {
	discover(): HookDiscoverResult;
	describeHook(name: string): HookDescriptor;
	run(name: string, input: unknown): HookResult | unknown;
	toHcpServer(): HcpServer;
}
