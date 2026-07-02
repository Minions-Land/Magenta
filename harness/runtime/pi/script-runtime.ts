import type { HcpCall, HcpTarget, HcpTargetDescription } from "../../assembly/hcp/pi/hcp.ts";
import { execProcess, type ProcessExecInput, type ProcessExecOutput } from "./process-runtime.ts";

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

export const SCRIPT_RUNTIME_SPECS: readonly RuntimeSpec[] = [
	{
		name: "shell",
		command: "sh",
		execFlag: "-c",
		description: "Run POSIX shell code through runtime://process.",
	},
	{
		name: "python",
		command: "python3",
		execFlag: "-c",
		description: "Run Python code through runtime://process.",
	},
	{
		name: "node",
		command: "node",
		execFlag: "-e",
		description: "Run JavaScript code through runtime://process.",
	},
	{
		name: "r",
		command: "Rscript",
		execFlag: "-e",
		description: "Run R code through runtime://process.",
	},
	{
		name: "julia",
		command: "julia",
		execFlag: "-e",
		description: "Run Julia code through runtime://process.",
	},
];

function runtimeNameFromTarget(target: string): string {
	if (target.startsWith("runtime://")) return target.slice("runtime://".length);
	const index = target.indexOf(":");
	return index === -1 ? target : target.slice(index + 1).replace(/^\/\//, "");
}

function runtimeSpec(name: string): RuntimeSpec | undefined {
	return SCRIPT_RUNTIME_SPECS.find((spec) => spec.name === name);
}

function normalizeInput(input: unknown): ScriptRuntimeInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return {};
	}
	return input as ScriptRuntimeInput;
}

export async function execScriptRuntime(
	spec: RuntimeSpec,
	input: ScriptRuntimeInput,
	signal?: AbortSignal,
): Promise<ScriptRuntimeOutput> {
	const code = input.code ?? input.script ?? "";
	if (code.trim() === "") {
		throw new Error("script runtime requires non-empty code");
	}
	const args = [spec.execFlag, code];
	if (spec.name === "shell") {
		args.push("magenta-runtime-shell");
	}
	args.push(...(input.args ?? []));
	const output = await execProcess(
		{
			command: spec.command,
			args,
			stdin_json: input.stdin_json,
			cwd: input.cwd,
			workspace_root: input.workspace_root,
			sandbox: input.sandbox,
			tool: input.tool,
			allow_direct_exec: input.allow_direct_exec,
			env_overrides: input.env_overrides,
			max_output_bytes: input.max_output_bytes,
			timeout_ms: input.timeout_ms,
		},
		signal,
	);
	return {
		...output,
		runtime: spec.name,
		compiled_to: "runtime://process",
	};
}

export class ScriptRuntimeProvider {
	describe(): HcpTargetDescription {
		return {
			target: "runtime://{shell,python,node,r,julia}",
			kind: "runtime",
			ops: ["discover", "describe", "exec", "call", "run"],
			description: "Script runtime wrappers compiled to runtime://process.",
			metadata: {
				implementation: "native-ts",
				source: "magenta-native",
				origin: "magenta1-general-harness",
				compiledTo: "runtime://process",
			},
		};
	}

	discover(): Record<string, unknown> {
		return {
			provider: "script-runtime",
			targets: SCRIPT_RUNTIME_SPECS.map((spec) => `runtime://${spec.name}`),
			compiled_to: "runtime://process",
		};
	}

	describeRuntime(name: string): Record<string, unknown> {
		const spec = runtimeSpec(name);
		if (!spec) {
			throw new Error(`unknown runtime target: runtime://${name}`);
		}
		return {
			name: spec.name,
			target: `runtime://${spec.name}`,
			description: spec.description,
			compiled_to: "runtime://process",
			command: spec.command,
		};
	}

	toHcpTarget(): HcpTarget {
		return {
			describe: () => this.describe(),
			call: async (call: HcpCall): Promise<unknown> => {
				const name = runtimeNameFromTarget(call.target);
				switch (call.op || "exec") {
					case "discover":
					case "list":
						return this.discover();
					case "describe":
						return this.describeRuntime(name);
					case "exec":
					case "call":
					case "run": {
						const spec = runtimeSpec(name);
						if (!spec) {
							throw new Error(`unknown runtime target: runtime://${name}`);
						}
						return execScriptRuntime(spec, normalizeInput(call.input));
					}
					default:
						throw new Error(`unsupported script runtime operation ${call.op}`);
				}
			},
		};
	}
}
