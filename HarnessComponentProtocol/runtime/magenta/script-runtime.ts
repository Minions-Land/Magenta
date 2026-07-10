import type {
	ProcessRuntimeExecutor,
	RuntimeSpec,
	ScriptRuntimeDescription,
	ScriptRuntimeInput,
	ScriptRuntimeOutput,
} from "../HcpServer.ts";

export type {
	RuntimeSpec,
	ScriptRuntimeDescription,
	ScriptRuntimeInput,
	ScriptRuntimeOutput,
} from "../HcpServer.ts";

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

function runtimeSpec(name: string): RuntimeSpec | undefined {
	return SCRIPT_RUNTIME_SPECS.find((spec) => spec.name === name);
}

export async function execScriptRuntime(
	runtimeExec: ProcessRuntimeExecutor,
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
	const output = await runtimeExec(
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
	private readonly runtimeExec: ProcessRuntimeExecutor;

	constructor(runtimeExec: ProcessRuntimeExecutor) {
		this.runtimeExec = runtimeExec;
	}

	discover(): Record<string, unknown> {
		return {
			provider: "script-runtime",
			targets: SCRIPT_RUNTIME_SPECS.map((spec) => `runtime://${spec.name}`),
			compiled_to: "runtime://process",
		};
	}

	describeRuntime(name: string): ScriptRuntimeDescription {
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

	execRuntime(name: string, input: ScriptRuntimeInput, signal?: AbortSignal): Promise<ScriptRuntimeOutput> {
		const spec = runtimeSpec(name);
		if (!spec) {
			throw new Error(`unknown runtime target: runtime://${name}`);
		}
		return execScriptRuntime(this.runtimeExec, spec, input, signal);
	}
}
