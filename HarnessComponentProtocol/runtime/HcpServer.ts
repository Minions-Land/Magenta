import type { HcpMagnetBinding } from "../.HCP/HcpMagnetTypes.ts";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";
import type { SandboxProfile } from "../sandbox/HcpServer.ts";

export class HcpServer {
	readonly moduleName = "runtime";
	readonly description = "Process and script runtime execution.";

	private binding(magnet: {
		toCapability?(): unknown;
	}): HcpMagnetBinding<ProcessRuntimeProvider | ScriptRuntimeProvider> {
		return magnet.toCapability?.() as HcpMagnetBinding<ProcessRuntimeProvider | ScriptRuntimeProvider>;
	}

	describeSource(
		selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
	): HcpServerDescription {
		const binding = this.binding(magnet);
		if (binding.name === "process") {
			return {
				target: `capability:${selector}`,
				kind: binding.kind,
				ops: ["discover", "exec", "call", "policy", "status", "health"],
				description: "Spawn a local process with Magenta portable sandbox guardrails.",
				metadata: {
					name: binding.name,
					implementation: "native-ts",
					source: binding.source,
					origin: "magenta1-general-harness",
					osEnforcement: false,
					hotSwappable: magnet.hotSwappable ?? false,
				},
			};
		}
		if (binding.name === "script-runtimes") {
			const discovered = binding.instance.discover();
			return {
				target: `capability:${selector}`,
				kind: binding.kind,
				ops: ["discover", "list", "describe", "exec", "call", "run"],
				description: "Script runtime wrappers compiled to runtime://process.",
				metadata: {
					name: binding.name,
					implementation: "native-ts",
					source: binding.source,
					origin: "magenta1-general-harness",
					compiledTo: discovered.compiled_to,
					runtimes: this.runtimeTargets(discovered).map((target) => target.slice("runtime://".length)),
					hotSwappable: magnet.hotSwappable ?? false,
				},
			};
		}
		throw new Error(`Unknown runtime capability slot: ${binding.name}`);
	}

	sourceAddresses(selector: string, magnet: { toCapability?(): unknown }): string[] {
		const binding = this.binding(magnet);
		return [`capability:${selector}`, ...this.runtimeTargets(binding.instance.discover())];
	}

	callSource(
		_selector: string,
		magnet: { toCapability?(): unknown },
		request: HcpServerRequest,
	): Promise<unknown> | unknown {
		const binding = this.binding(magnet);
		const op = request.op || "call";
		if (binding.name === "process") {
			const provider = binding.instance as ProcessRuntimeProvider;
			switch (op) {
				case "discover":
					return provider.discover();
				case "exec":
				case "call":
					return provider.exec(request.input as ProcessExecInput);
				case "policy":
				case "status":
					return provider.policyStatus();
				case "health":
					return provider.health();
				default:
					throw new Error(`Unknown operation: ${op} for runtime:process`);
			}
		}
		if (binding.name === "script-runtimes") {
			const provider = binding.instance as ScriptRuntimeProvider;
			const runtimeName = this.runtimeName(request.target);
			switch (op) {
				case "discover":
				case "list":
					return provider.discover();
				case "describe":
					return provider.describeRuntime(runtimeName);
				case "exec":
				case "call":
				case "run":
					return provider.execRuntime(runtimeName, request.input as ScriptRuntimeInput);
				default:
					throw new Error(`Unknown operation: ${op} for runtime:script-runtimes`);
			}
		}
		throw new Error(`Unknown runtime capability slot: ${binding.name}`);
	}

	private runtimeTargets(discovered: Record<string, unknown>): string[] {
		return Array.isArray(discovered.targets)
			? discovered.targets.filter((target): target is string => typeof target === "string")
			: [];
	}

	private runtimeName(target: string): string {
		const match = target.match(/^runtime:\/\/([^/]+)/);
		return match?.[1] ?? "shell";
	}
}

export type ProcessRuntimeToolMetadata = {
	name?: string;
	operation?: string;
	read_only?: boolean;
	destructive?: boolean;
	tags?: string[];
	network?: unknown;
	network_targets?: unknown;
};

export type ProcessExecInput = {
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
};

export type RuntimePolicyReport = {
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
};

export type ProcessExecOutput = {
	stdout: string;
	stderr: string;
	status: number | null;
	policy: RuntimePolicyReport;
	truncated: {
		stdout: boolean;
		stderr: boolean;
	};
};

export type ProcessRuntimeExecutor = (input: ProcessExecInput, signal?: AbortSignal) => Promise<ProcessExecOutput>;

export type ProcessRuntimeManagedInput = Omit<ProcessExecInput, "stdin" | "max_output_bytes">;

export type ProcessRuntimeManagedExit = {
	status: number | null;
	signal: string | null;
	reason: "exit" | "error" | "abort" | "timeout" | "close";
	error?: Error;
};

export type ProcessRuntimeManagedHandle = {
	write(data: string): Promise<void>;
	onStdoutLine(listener: (line: string) => void): () => void;
	onStderr(listener: (chunk: string) => void): () => void;
	readonly exit: Promise<ProcessRuntimeManagedExit>;
	close(): Promise<void>;
};

export type ProcessRuntimeManagedSpawner = (
	input: ProcessRuntimeManagedInput,
	signal?: AbortSignal,
) => Promise<ProcessRuntimeManagedHandle>;

export type RuntimePolicyStatus = {
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
};

/**
 * Process runtime provider surface. Business logic only - HcpServer conversion
 * is handled by the unified capability-server adapter.
 */
export type ProcessRuntimeProvider = {
	discover(): Record<string, unknown>;
	exec: ProcessRuntimeExecutor;
	spawnManaged: ProcessRuntimeManagedSpawner;
	policyStatus(): RuntimePolicyStatus;
	health(): Promise<Record<string, unknown>>;
};

export type ScriptRuntimeInput = {
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
};

export type RuntimeSpec = {
	name: string;
	command: string;
	execFlag: string;
	description: string;
};

export type ScriptRuntimeOutput = ProcessExecOutput & {
	runtime: string;
	compiled_to: "runtime://process";
};

export type ScriptRuntimeDescription = {
	name: string;
	target: string;
	description: string;
	compiled_to: "runtime://process";
	command: string;
};

/**
 * Script runtime provider surface. Business logic only - HcpServer conversion
 * is handled by the unified capability-server adapter.
 */
export type ScriptRuntimeProvider = {
	discover(): Record<string, unknown>;
	describeRuntime(name: string): ScriptRuntimeDescription;
	execRuntime(name: string, input: ScriptRuntimeInput, signal?: AbortSignal): Promise<ScriptRuntimeOutput>;
};
