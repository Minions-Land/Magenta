import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import type { HarnessCatalogEntry, HarnessComponentCatalog } from "../catalog/pi/catalog.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "../core/utils/pi/truncate.ts";
import { parseToml, type TomlTable } from "../hcp-client/registry/registry.ts";
import type { HcpRequest } from "../hcp-contract/hcp-server.ts";
import {
	execProcess,
	type ProcessExecInput,
	type ProcessExecOutput,
	type ProcessRuntimeToolMetadata,
	type RuntimePolicyReport,
} from "../modules/runtime/magenta/process-runtime.ts";
import type { SandboxProfile, SandboxSelection } from "../modules/sandbox/contract.ts";
import { loadSandboxProviderFromPack, selectSandboxProfile } from "../modules/sandbox/magenta/sandbox.ts";
import { UniversalMagnet } from "./universal.ts";

export interface ProcessToolManifest {
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
	 * code. Flows through {@link ProcessToolMagnet.toTool} onto AgentTool.renderKind.
	 */
	render_kind?: string;
	parameters?: TSchema | Record<string, unknown>;
}

export interface ProcessToolMagnetOptions {
	manifest: ProcessToolManifest;
	/** Root used to resolve package-relative manifest commands. */
	manifestRoot: string;
	/** Workspace cwd passed as the child working directory. */
	cwd: string;
	/** Optional command path override, useful when the Rust binary is built elsewhere. */
	commandOverride?: string;
	/** Extra environment values for the process. */
	env?: NodeJS.ProcessEnv;
	/** Max captured stdout/stderr bytes. Default: 10 MiB. */
	maxOutputBytes?: number;
	/** Optional resolved sandbox profile supplied by SandboxProvider. */
	sandboxProfile?: SandboxProfile;
	/** Runtime boundary. Defaults to the native TS runtime://process provider. */
	runtimeExec?: (input: ProcessExecInput, signal?: AbortSignal) => Promise<ProcessExecOutput>;
}

export interface ProcessInvocation {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
	policyInput?: unknown;
	timeoutMs?: number;
	workspaceRoot?: string;
}

export interface ProcessToolSpec<TParameters extends TSchema = TSchema> {
	name: string;
	label?: string;
	description: string;
	parameters: TParameters;
	buildInvocation: (params: unknown) => ProcessInvocation;
	toolMetadata?: ProcessRuntimeToolMetadata;
	sandbox?: {
		selection: SandboxSelection;
		profile?: SandboxProfile;
	};
	runtimeExec?: (input: ProcessExecInput, signal?: AbortSignal) => Promise<ProcessExecOutput>;
	maxOutputBytes?: number;
}

export interface ProcessToolDetails {
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
}

const processToolBuilds = new Map<string, Promise<void>>();

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

function resolveCatalogLocalPath(catalog: HarnessComponentCatalog, path: string): string {
	if (isAbsolute(path)) return path;
	return resolve(resolveCatalogLocalRoot(catalog), path);
}

function resolveCatalogLocalRoot(catalog: HarnessComponentCatalog): string {
	let dir = dirname(catalog.inventoryPath);
	while (true) {
		if (existsSync(join(dir, "harness.toml"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(dirname(catalog.inventoryPath), "..");
		dir = parent;
	}
}

function resolveCatalogSourcePath(catalog: HarnessComponentCatalog, path: string): string {
	if (isAbsolute(path)) return path;
	return resolve(catalog.inventory.repository_root, path);
}

function resolveCatalogComponentPath(catalog: HarnessComponentCatalog, entry: HarnessCatalogEntry): string {
	const mappedPath = entry.migration.component?.path;
	if (mappedPath) {
		return resolveCatalogLocalPath(catalog, mappedPath);
	}
	if (!entry.path) {
		throw new Error(`Catalog entry ${entry.id} has no manifest path`);
	}
	return resolveCatalogSourcePath(catalog, entry.path);
}

function resolveCatalogManifestRoot(catalog: HarnessComponentCatalog, entry: HarnessCatalogEntry): string {
	if (entry.migration.component?.path) {
		return resolveCatalogLocalRoot(catalog);
	}
	return catalog.inventory.repository_root;
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

export async function createProcessToolMagnetFromCatalogEntry(
	catalog: HarnessComponentCatalog,
	entry: HarnessCatalogEntry,
	options: Omit<ProcessToolMagnetOptions, "manifest" | "manifestRoot">,
): Promise<ProcessToolMagnet<TSchema>> {
	const manifestPath = resolveCatalogComponentPath(catalog, entry);
	const manifest = await loadProcessToolManifest(manifestPath);
	const sandboxProfile = options.sandboxProfile ?? (await loadCatalogSandboxProfile(catalog, manifest));
	return new ProcessToolMagnet({
		...options,
		manifest,
		sandboxProfile,
		manifestRoot: resolveCatalogManifestRoot(catalog, entry),
	});
}

async function loadCatalogSandboxProfile(
	catalog: HarnessComponentCatalog,
	manifest: ProcessToolManifest,
): Promise<SandboxProfile | undefined> {
	const packPath = resolve(resolveCatalogLocalRoot(catalog), "modules/sandbox/sandbox.toml");
	if (!(await fileExists(packPath))) return undefined;
	const provider = await loadSandboxProviderFromPack(packPath);
	const selection = selectSandboxProfile({
		tool: {
			name: manifest.name,
			operation: manifest.operation,
			read_only: manifest.read_only ?? false,
			destructive: manifest.destructive ?? false,
			tags: manifest.tags ?? [],
		},
	});
	return provider.get(selection.profile);
}

async function commandExists(command: string): Promise<boolean> {
	if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
		try {
			await access(command);
			return true;
		} catch {
			return false;
		}
	}
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		try {
			await access(join(dir, command));
			return true;
		} catch {
			// keep searching PATH
		}
	}
	return false;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isMigratedProcessToolBinary(command: string): boolean {
	return /\/tools\/[^/]+\/magenta\/process-tools\/target\/release\/magenta-process-tools$/.test(command);
}

function inferProcessToolsCrateDir(command: string): string {
	return dirname(dirname(dirname(command)));
}

async function runCargoBuild(crateDir: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("cargo", ["build", "--release", "--manifest-path", join(crateDir, "Cargo.toml")], {
			cwd: crateDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (status) => {
			if (status === 0) {
				resolvePromise();
				return;
			}
			reject(
				new Error(
					`failed to build migrated process-tools, cargo exited with ${status}\n${Buffer.concat(stdout).toString("utf-8")}${Buffer.concat(stderr).toString("utf-8")}`,
				),
			);
		});
	});
}

async function ensureCommandReady(command: string): Promise<void> {
	if (!(command.includes("/") || command.includes("\\") || isAbsolute(command))) return;
	if (await fileExists(command)) return;
	if (!isMigratedProcessToolBinary(command)) return;

	const crateDir = inferProcessToolsCrateDir(command);
	let build = processToolBuilds.get(crateDir);
	if (!build) {
		build = runCargoBuild(crateDir).finally(() => {
			processToolBuilds.delete(crateDir);
		});
		processToolBuilds.set(crateDir, build);
	}
	await build;
}

/**
 * HcpMagnet for Magenta1-style Rust process tools.
 *
 * Protocol: execute `command args...` through `runtime://process`, write JSON
 * params to stdin, read stdout as the tool result. The Rust binary still owns
 * tool behavior; the TS runtime owns portable process governance.
 */
export class ProcessToolMagnet<TParameters extends TSchema = TSchema> extends UniversalMagnet {
	private readonly manifestOptions?: ProcessToolMagnetOptions;
	private readonly spec?: ProcessToolSpec<TParameters>;
	private readonly command?: string;
	private readonly args?: string[];
	private readonly toolName: string;

	constructor(options: ProcessToolMagnetOptions);
	constructor(spec: ProcessToolSpec<TParameters>, kind?: string);
	constructor(optionsOrSpec: ProcessToolMagnetOptions | ProcessToolSpec<TParameters>, kind = "process") {
		const manifestOptions = isProcessToolMagnetOptions(optionsOrSpec) ? optionsOrSpec : undefined;
		const spec = manifestOptions ? undefined : (optionsOrSpec as ProcessToolSpec<TParameters>);
		const manifest = manifestOptions?.manifest;
		const descriptorName = manifest?.name ?? spec!.name;
		const toolName = manifest ? toToolName(manifest.name) : spec!.name;
		const label = manifest ? manifest.name : (spec!.label ?? spec!.name);
		const description = manifest ? manifest.description : spec!.description;
		const operation = manifest?.operation ?? spec?.toolMetadata?.operation;
		const readOnly = manifest ? (manifest.read_only ?? false) : spec?.toolMetadata?.read_only;
		const destructive = manifest ? (manifest.destructive ?? false) : spec?.toolMetadata?.destructive;
		const tags = manifest?.tags ?? spec?.toolMetadata?.tags ?? [];
		super({
			descriptor: {
				target: `tool://${descriptorName}`,
				kind: "tool",
				name: descriptorName,
				implementation: kind,
				description,
				ops: ["describe", "configure", "enable", "disable", "health", "state", "toTool", "call"],
				metadata: {
					label,
					operation,
					readOnly,
					destructive,
					version: manifest?.version,
					tags,
					capabilities: manifest?.capabilities ?? [],
					toolName,
				},
			},
		});
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
		const options = this.requireManifestOptions();
		return selectSandboxProfile({
			tool: {
				name: options.manifest.name,
				operation: options.manifest.operation,
				read_only: options.manifest.read_only ?? false,
				destructive: options.manifest.destructive ?? false,
				tags: options.manifest.tags ?? [],
			},
		});
	}

	override async health(): Promise<Record<string, unknown>> {
		const command = this.command;
		return {
			...(await super.health()),
			command,
			args: this.args,
			commandExists: command ? await commandExists(command) : undefined,
			sandbox: this.sandboxSelection(),
			sandboxEnforced: Boolean(this.manifestOptions?.sandboxProfile ?? this.spec?.sandbox?.profile),
			runtime: "runtime://process",
		};
	}

	override toTool(): AgentTool<TParameters, ProcessToolDetails> {
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

	protected override async handleHcpRequest(call: HcpRequest): Promise<unknown> {
		switch (call.op) {
			case "call":
			case "run":
			case "execute":
				return this.executeProcess(call.input, undefined);
			default:
				return super.handleHcpRequest(call);
		}
	}

	private async executeProcess(
		input: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>,
	): Promise<AgentToolResult<ProcessToolDetails>> {
		this.assertEnabled();
		if (this.spec) return this.executeSpecProcess(input, signal, onUpdate);
		return this.executeManifestProcess(input, signal);
	}

	private async executeManifestProcess(
		input: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ProcessToolDetails>> {
		const options = this.requireManifestOptions();
		const command = this.command!;
		const args = this.args ?? [];
		await ensureCommandReady(command);
		const sandbox = this.sandboxSelection();
		const runtimeExec = options.runtimeExec ?? execProcess;
		const output = await runtimeExec(
			{
				command,
				args,
				stdin_json: input ?? {},
				cwd: options.cwd,
				workspace_root: options.cwd,
				sandbox: options.sandboxProfile ? { profile: options.sandboxProfile } : null,
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
				target: `tool://${options.manifest.name}`,
				command,
				args,
				cwd: options.cwd,
				sandbox,
				sandboxEnforced: Boolean(options.sandboxProfile),
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
		const command = invocation.command;
		const args = invocation.args ?? [];
		const cwd = invocation.cwd ?? process.cwd();
		const workspaceRoot = invocation.workspaceRoot ?? cwd;
		await ensureCommandReady(command);

		const detailsBase = (): ProcessToolDetails => ({
			status: null,
			target: `tool://${spec.name}`,
			command,
			args,
			cwd,
			sandbox: spec.sandbox?.selection,
			sandboxEnforced: Boolean(spec.sandbox?.profile),
			runtime: "runtime://process",
		});

		onUpdate?.({ content: [], details: detailsBase() });

		const runtimeExec = spec.runtimeExec ?? execProcess;
		const output = await runtimeExec(
			{
				command,
				args,
				stdin: invocation.stdin,
				stdin_json: invocation.policyInput ?? input ?? {},
				cwd,
				workspace_root: workspaceRoot,
				sandbox: spec.sandbox?.profile ? { profile: spec.sandbox.profile } : null,
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

	private requireManifestOptions(): ProcessToolMagnetOptions {
		if (!this.manifestOptions) throw new Error(`${this.toolName}: process manifest options are not available`);
		return this.manifestOptions;
	}

	private requireSpec(): ProcessToolSpec<TParameters> {
		if (!this.spec) throw new Error(`${this.toolName}: process spec is not available`);
		return this.spec;
	}
}

export const PROCESS_TOOL_DESCRIPTION = `Execute a package-declared process tool. Returns combined stdout/stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`;

function isProcessToolMagnetOptions(
	value: ProcessToolMagnetOptions | ProcessToolSpec,
): value is ProcessToolMagnetOptions {
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
