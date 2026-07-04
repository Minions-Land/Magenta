import type { HcpServer } from "../../hcp-contract/hcp-server.ts";

export type SandboxNetworkPolicy = "deny" | "allowlist" | "allow" | string;

export interface SandboxProfile {
	kind: "sandbox" | string;
	name: string;
	description: string;
	fs_read: string[];
	fs_write: string[];
	network: SandboxNetworkPolicy;
	network_allowlist: string[];
	max_memory_mb: number;
	max_wall_seconds: number;
	env_allowlist: string[];
	backend: string;
	source?: string;
	origin?: string;
	origin_rel?: string;
	path?: string;
}

export interface SandboxSelectionTool {
	read_only?: boolean;
	destructive?: boolean;
	tags?: string[];
	operation?: string;
	name?: string;
}

export interface SandboxSelection {
	profile: string;
	reason: {
		read_only: boolean;
		destructive: boolean;
		trusted: boolean;
		network_read: boolean;
		workspace_write: boolean;
	};
}

export interface SandboxDiscoverResult {
	provider: "sandbox";
	targets: string[];
	profiles: SandboxProfile[];
	selectionTarget: "hook://sandbox-select";
	enforcement: "not-ported";
}

export interface SandboxProviderOptions {
	profiles: SandboxProfile[];
}

export interface SandboxProviderContract {
	get(name: string): SandboxProfile;
	list(): SandboxProfile[];
	discover(): SandboxDiscoverResult;
	resolve(input: unknown, fallbackName?: string): { selection: SandboxSelection; profile: SandboxProfile };
	toSandboxHcpServer(): HcpServer;
	toSandboxSelectHcpServer(): HcpServer;
}
