import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import { parseToml, type TomlTable } from "../.HCP/registry/registry.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "../_magenta/utils/pi/truncate.ts";
import type {
	ProcessExecOutput,
	ProcessRuntimeExecutor,
	ProcessRuntimeToolMetadata,
	RuntimePolicyReport,
} from "../runtime/HcpServer.ts";
import type { SandboxProfile, SandboxProvider, SandboxSelection } from "../sandbox/HcpServer.ts";

export type ProcessToolManifest = {
	kind: "process" | string;
	name: string;
	description: string;
	command: string;
	args?: string[];
	operation?: string;
	read_only?: boolean;
	destructive?: boolean;
	internal?: boolean;
	version?: string;
	tags?: string[];
	capabilities?: string[];
	requires?: string[];
	/**
	 * Optional UI data-shape identifier. Declares what kind of data this tool's
	 * result carries so a host-side renderer can draw it without per-tool host
	 * code. Flows through {@link ProcessTool.toTool} onto AgentTool.renderKind.
	 */
	render_kind?: string;
	parameters?: TSchema | Record<string, unknown>;
};

export type ProcessToolExecution = {
	runtimeExec: ProcessRuntimeExecutor;
	sandbox: {
		selection: SandboxSelection;
		profile: SandboxProfile;
	};
	maxOutputBytes?: number;
};

export type ProcessToolOptions = ProcessToolExecution & {
	manifest: ProcessToolManifest;
	/** Root used to resolve package-relative manifest commands. */
	manifestRoot: string;
	/** Workspace cwd passed as the child working directory. */
	cwd: string;
	/** Optional command path override, useful when the Rust binary is built elsewhere. */
	commandOverride?: string;
	/** Extra environment values for the process. */
	env?: NodeJS.ProcessEnv;
};

export type ProcessInvocation = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
	policyInput?: unknown;
	timeoutMs?: number;
	workspaceRoot?: string;
};

export type ProcessToolSpec<TParameters extends TSchema = TSchema> = ProcessToolExecution & {
	name: string;
	label?: string;
	description: string;
	parameters: TParameters;
	buildInvocation: (params: unknown) => ProcessInvocation;
	toolMetadata?: ProcessRuntimeToolMetadata;
};

export type ProcessToolDetails = {
	status: number | null;
	exitCode?: number | null;
	stderr?: string;
	target: string;
	command: string;
	args: string[];
	cwd?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	sandbox?: SandboxSelection;
	sandboxEnforced: boolean;
	runtime: "runtime://process";
	runtimePolicy?: RuntimePolicyReport;
};

function toToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function defaultParameters(): TSchema {
	return Type.Object({}, { additionalProperties: true });
}

function resolveCommand(root: string, command: string, override?: string): string {
	const selected = override ?? command;
	if (isAbsolute(selected)) return selected;
	if (selected.includes("/") || selected.includes("\\")) return resolve(root, selected);
	return selected;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function processToolManifestFromToml(table: TomlTable): ProcessToolManifest {
	const name = asString(table.name);
	const description = asString(table.description);
	const command = asString(table.command);
	if (!name || !description || !command) {
		throw new Error("process tool manifest requires name, description, and command");
	}
	return {
		kind: asString(table.kind) ?? "process",
		name,
		description,
		command,
		args: asStringArray(table.args),
		operation: asString(table.operation),
		read_only: asBoolean(table.read_only),
		destructive: asBoolean(table.destructive),
		internal: asBoolean(table.internal),
		version: asString(table.version),
		tags: asStringArray(table.tags),
		capabilities: asStringArray(table.capabilities),
		requires: asStringArray(table.requires),
		render_kind: asString(table.render_kind),
		parameters: asObject(table.parameters),
	};
}

export async function loadProcessToolManifest(path: string): Promise<ProcessToolManifest> {
	return processToolManifestFromToml(parseToml(await readFile(path, "utf-8")));
}

export type ProcessToolDescriptorOptions = {
	descriptorPath: string;
	source: string;
	cwd: string;
	runtimeExec: ProcessRuntimeExecutor;
	sandboxResolve: SandboxProvider["resolve"];
};

/** Build one process-backed tool from a component descriptor and explicit runtime dependencies. */
export async function createProcessToolFromDescriptor(options: ProcessToolDescriptorOptions): Promise<ProcessTool> {
	const descriptor = parseToml(await readFile(options.descriptorPath, "utf-8"));
	const componentName = asString(descriptor.name);
	if (!componentName) throw new Error(`${options.descriptorPath} has no component name`);
	const sourceConfig = asObject(asObject(descriptor.source_config)?.[options.source]);
	const implementationManifestPath =
		asString(sourceConfig?.implementation_manifest) ?? asString(descriptor.implementation_manifest);
	if (!implementationManifestPath) {
		throw new Error(`${options.descriptorPath} has no implementation_manifest for source=${options.source}`);
	}
	const manifestPath = resolve(dirname(options.descriptorPath), implementationManifestPath);
	const implementationManifest = await loadProcessToolManifest(manifestPath);
	const manifest = { ...implementationManifest, name: componentName };
	return new ProcessTool({
		manifest,
		manifestRoot: dirname(manifestPath),
		cwd: options.cwd,
		runtimeExec: options.runtimeExec,
		sandbox: options.sandboxResolve({
			tool: {
				name: manifest.name,
				operation: manifest.operation,
				read_only: manifest.read_only ?? false,
				destructive: manifest.destructive ?? false,
				tags: manifest.tags ?? [],
			},
		}),
	});
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureCommandReady(command: string): Promise<string> {
	if (!(command.includes("/") || command.includes("\\") || isAbsolute(command))) return command;
	if (await fileExists(command)) return command;
	if (process.platform === "win32" && (await fileExists(`${command}.exe`))) return `${command}.exe`;
	throw new Error(`process tool command is not built or does not exist: ${command}`);
}

/**
 * AgentTool product adapter for Magenta1-style Rust process tools.
 *
 * Protocol: execute `command args...` through `runtime://process`, write JSON
 * params to stdin, read stdout as the tool result. The Rust binary still owns
 * tool behavior; the TS runtime owns portable process governance.
 */
export class ProcessTool<TParameters extends TSchema = TSchema> {
	readonly kind: string;
	private readonly manifestOptions?: ProcessToolOptions;
	private readonly spec?: ProcessToolSpec<TParameters>;
	private readonly command?: string;
	private readonly args?: string[];
	private readonly toolName: string;

	constructor(options: ProcessToolOptions);
	constructor(spec: ProcessToolSpec<TParameters>, kind?: string);
	constructor(optionsOrSpec: ProcessToolOptions | ProcessToolSpec<TParameters>, kind = "process") {
		const manifestOptions = isProcessToolOptions(optionsOrSpec) ? optionsOrSpec : undefined;
		const spec = manifestOptions ? undefined : (optionsOrSpec as ProcessToolSpec<TParameters>);
		const manifest = manifestOptions?.manifest;
		const toolName = manifest ? toToolName(manifest.name) : spec!.name;
		this.kind = kind;
		if (manifestOptions) {
			this.manifestOptions = manifestOptions;
			this.command = resolveCommand(
				manifestOptions.manifestRoot,
				manifestOptions.manifest.command,
				manifestOptions.commandOverride,
			);
			this.args = [...(manifestOptions.manifest.args ?? [])];
		} else {
			this.spec = spec;
		}
		this.toolName = toolName;
	}

	sandboxSelection(): SandboxSelection {
		if (this.spec?.sandbox?.selection) return this.spec.sandbox.selection;
		return this.requireManifestOptions().sandbox.selection;
	}

	toTool(): AgentTool<TParameters, ProcessToolDetails> {
		const manifest = this.manifestOptions?.manifest;
		const parameters = (
			manifest
				? ((manifest.parameters as TParameters | undefined) ?? defaultParameters())
				: this.requireSpec().parameters
		) as TParameters;
		return {
			name: this.toolName,
			label: manifest?.name ?? this.spec?.label ?? this.toolName,
			description: manifest?.description ?? this.requireSpec().description,
			parameters,
			...(manifest?.render_kind ? { renderKind: manifest.render_kind } : {}),
			execute: async (_toolCallId, params, signal, onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>) =>
				this.executeProcess(params, signal, onUpdate),
		};
	}

	private async executeProcess(
		input: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>,
	): Promise<AgentToolResult<ProcessToolDetails>> {
		if (this.spec) return this.executeSpecProcess(input, signal, onUpdate);
		return this.executeManifestProcess(input, signal);
	}

	private async executeManifestProcess(
		input: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ProcessToolDetails>> {
		const options = this.requireManifestOptions();
		const command = await ensureCommandReady(this.command!);
		const args = this.args ?? [];
		const sandbox = this.sandboxSelection();
		const output = await options.runtimeExec(
			{
				command,
				args,
				stdin_json: input ?? {},
				cwd: options.cwd,
				workspace_root: options.cwd,
				sandbox: { profile: options.sandbox.profile },
				tool: {
					name: options.manifest.name,
					operation: options.manifest.operation,
					read_only: options.manifest.read_only ?? false,
					destructive: options.manifest.destructive ?? false,
					tags: options.manifest.tags ?? [],
				},
				allow_direct_exec: false,
				env_overrides: options.env as Record<string, string> | undefined,
				max_output_bytes: options.maxOutputBytes,
			},
			signal,
		);
		const stdoutSuffix = output.truncated.stdout ? "\n[stdout truncated]" : "";
		const stderrSuffix = output.truncated.stderr ? "\n[stderr truncated]" : "";
		if (output.status !== 0) {
			throw new Error(
				`process tool ${options.manifest.name} exited with status ${output.status}\n${output.stderr}${stderrSuffix}`,
			);
		}
		return {
			content: [{ type: "text", text: `${output.stdout}${stdoutSuffix}` }],
			details: {
				status: output.status,
				exitCode: output.status,
				stderr: output.stderr ? `${output.stderr}${stderrSuffix}` : undefined,
				target: `tool:${options.manifest.name}`,
				command,
				args,
				cwd: options.cwd,
				sandbox,
				sandboxEnforced: true,
				runtime: "runtime://process",
				runtimePolicy: output.policy,
			},
		};
	}

	private async executeSpecProcess(
		input: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>,
	): Promise<AgentToolResult<ProcessToolDetails>> {
		const spec = this.requireSpec();
		const invocation = spec.buildInvocation(input);
		const command = await ensureCommandReady(invocation.command);
		const args = invocation.args ?? [];
		const cwd = invocation.cwd ?? process.cwd();
		const workspaceRoot = invocation.workspaceRoot ?? cwd;
		const detailsBase = (): ProcessToolDetails => ({
			status: null,
			target: `tool:${spec.name}`,
			command,
			args,
			cwd,
			sandbox: spec.sandbox?.selection,
			sandboxEnforced: true,
			runtime: "runtime://process",
		});

		onUpdate?.({ content: [], details: detailsBase() });

		const output = await spec.runtimeExec(
			{
				command,
				args,
				stdin: invocation.stdin,
				stdin_json: invocation.policyInput ?? input ?? {},
				cwd,
				workspace_root: workspaceRoot,
				sandbox: { profile: spec.sandbox.profile },
				tool: spec.toolMetadata ?? { name: spec.name },
				allow_direct_exec: false,
				env_overrides: invocation.env as Record<string, string> | undefined,
				max_output_bytes: spec.maxOutputBytes ?? DEFAULT_MAX_BYTES,
				timeout_ms: invocation.timeoutMs,
			},
			signal,
		);

		const text = formatRuntimeOutput(output.stdout, output.stderr, output.truncated);
		const details: ProcessToolDetails = {
			...detailsBase(),
			status: output.status,
			exitCode: output.status,
			runtimePolicy: output.policy,
		};
		onUpdate?.({ content: [{ type: "text", text }], details });
		if (signal?.aborted) {
			throw new Error(appendStatus(text, "Process aborted"));
		}
		if (output.status !== 0 && output.status !== null) {
			throw new Error(appendStatus(text, `Process exited with code ${output.status}`));
		}
		return { content: [{ type: "text", text }], details };
	}

	private requireManifestOptions(): ProcessToolOptions {
		if (!this.manifestOptions) throw new Error(`${this.toolName}: process manifest options are not available`);
		return this.manifestOptions;
	}

	private requireSpec(): ProcessToolSpec<TParameters> {
		if (!this.spec) throw new Error(`${this.toolName}: process spec is not available`);
		return this.spec;
	}
}

export const PROCESS_TOOL_DESCRIPTION = `Execute a package-declared process tool. Returns combined stdout/stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`;

function isProcessToolOptions(value: ProcessToolOptions | ProcessToolSpec): value is ProcessToolOptions {
	return "manifest" in value;
}

function appendStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`;
}

function formatRuntimeOutput(stdout: string, stderr: string, truncated: ProcessExecOutput["truncated"]): string {
	const parts = [stdout, stderr].filter((part) => part.length > 0);
	let text = parts.join(stdout && stderr ? "\n" : "") || "(no output)";
	if (truncated.stdout) text += "\n[stdout truncated]";
	if (truncated.stderr) text += "\n[stderr truncated]";
	return text;
}
