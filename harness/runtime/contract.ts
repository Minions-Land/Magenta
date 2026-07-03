import type { HcpTarget } from "../assembly/hcp/hcp.ts";
import type { SandboxProfile } from "../sandbox/contract.ts";

export interface ProcessRuntimeToolMetadata {
	name?: string;
	operation?: string;
	read_only?: boolean;
	destructive?: boolean;
	tags?: string[];
	network?: unknown;
	network_targets?: unknown;
}

export interface ProcessExecInput {
	command: string;
	args?: string[];
	stdin?: string;
	stdin_json?: unknown;
	cwd?: string;
	workspace_root?: string;
	sandbox?: { profile?: SandboxProfile } | SandboxProfile | null;
	tool?: ProcessRuntimeToolMetadata | null;
	allow_direct_exec?: boolean;
	env_overrides?: Record<string, string>;
	max_output_bytes?: number;
	timeout_ms?: number;
}

export interface RuntimePolicyReport {
	workspace_root: string;
	process_cwd: string;
	fs_read: string[];
	fs_write: string[];
	network: string;
	network_allowlist: string[];
	max_wall_seconds: number;
	max_memory_mb: number;
	backend: string;
	resolved_backend: "none";
	os_enforced: false;
	backend_reason: string;
}

export interface ProcessExecOutput {
	stdout: string;
	stderr: string;
	status: number | null;
	policy: RuntimePolicyReport;
	truncated: {
		stdout: boolean;
		stderr: boolean;
	};
}

export interface RuntimePolicyStatus {
	portable_guards: string[];
	os_backends: {
		auto_enabled: false;
		auto_candidate: null;
		sandbox_exec_available: false;
		bwrap_available: false;
	};
	production_audit: {
		os_egress_allowlist: false;
		note: string;
	};
}

export interface ProcessRuntimeProviderContract {
	discover(): Record<string, unknown>;
	exec(input: ProcessExecInput, signal?: AbortSignal): Promise<ProcessExecOutput>;
	policyStatus(): RuntimePolicyStatus;
	health(): Promise<Record<string, unknown>>;
	toHcpTarget(): HcpTarget;
}

export interface ScriptRuntimeInput {
	code?: string;
	script?: string;
	args?: string[];
	stdin_json?: unknown;
	cwd?: string;
	workspace_root?: string;
	sandbox?: ProcessExecInput["sandbox"];
	tool?: ProcessExecInput["tool"];
	allow_direct_exec?: boolean;
	env_overrides?: Record<string, string>;
	max_output_bytes?: number;
	timeout_ms?: number;
}

export interface RuntimeSpec {
	name: string;
	command: string;
	execFlag: string;
	description: string;
}

export interface ScriptRuntimeOutput extends ProcessExecOutput {
	runtime: string;
	compiled_to: "runtime://process";
}

export interface ScriptRuntimeDescription {
	name: string;
	target: string;
	description: string;
	compiled_to: "runtime://process";
	command: string;
}

export interface ScriptRuntimeProviderContract {
	discover(): Record<string, unknown>;
	describeRuntime(name: string): ScriptRuntimeDescription;
	execRuntime(name: string, input: ScriptRuntimeInput, signal?: AbortSignal): Promise<ScriptRuntimeOutput>;
	toHcpTarget(): HcpTarget;
}
