import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parametersFromToml } from "../../_magenta/mcp/schema.ts";
import { discoverMcpTools, type McpToolOptions, mcpToolName } from "../../_magenta/mcp/tool.ts";
import type { PackageToolDiagnostic } from "../../_magenta/packages/tool-diagnostic.ts";
import { parseToml, type TomlTable } from "../../_magenta/utils/pi/toml.ts";
import type { ProcessRuntimeProvider, ScriptRuntimeProvider } from "../../runtime/HcpServer.ts";
import type { SandboxProvider } from "../../sandbox/HcpServer.ts";
import { ProcessTool } from "../process-tool.ts";
import { type PythonLauncherResolver, PythonModuleTool } from "../python-module-tool.ts";

export type { PackageToolDiagnostic, PackageToolDiagnosticCode } from "../../_magenta/packages/tool-diagnostic.ts";

export type PackageToolComponent = {
	packageId: string;
	packageDir: string;
	profile?: string;
	kind: string;
	name: string;
	description?: string;
	path?: string;
	sourcePath: string;
};

export type PackageToolRuntimeComponent = {
	packageId: string;
	packageDir: string;
	kind: string;
	name: string;
	path?: string;
};

export type PackageToolContext = {
	resolveCapability<T>(name: string): T | undefined;
	repoRoot: string;
	components: PackageToolRuntimeComponent[];
	componentMap: Map<string, PackageToolRuntimeComponent>;
};

export type CreatePackageToolProductOptions = {
	component: PackageToolComponent;
	context: PackageToolContext;
};

export type CreatePackageToolProductResult = {
	product?: HcpMagnettoolproduct;
	diagnostics: PackageToolDiagnostic[];
};

export type HcpMagnettoolproduct = {
	readonly kind: string;
	readonly source?: string;
	toTool(): AgentTool;
	close?(): void | Promise<void>;
};

export type PackageToolBuildSettings = {
	component: PackageToolComponent;
	components: PackageToolRuntimeComponent[];
	componentMap: Map<string, PackageToolRuntimeComponent>;
	diagnostics: PackageToolDiagnostic[];
	mcp?: McpToolOptions;
	toolName?: string;
};

/** Expand one MCP server descriptor into one single-product build setting per remote tool. */
export async function expandPackageToolBuildSettings(
	settings: PackageToolBuildSettings,
	context: PackageToolContext,
): Promise<PackageToolBuildSettings[]> {
	const { component, diagnostics } = settings;
	const descriptor = await readPackageToolDescriptor(component, diagnostics);
	if (!descriptor) return [];
	const runtime = asString(descriptor.runtime) ?? asString(descriptor.kind);
	if (runtime !== "mcp") return [settings];

	const command = asString(descriptor.command);
	if (!command) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} MCP tool ${component.name} must declare command.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return [];
	}
	const processRuntime = HcpMagnetpackagetoolprocessruntime(context, component, diagnostics);
	const toolMetadata = toolMetadataFromDescriptor(asString(descriptor.name) ?? component.name, descriptor);
	const sandbox = HcpMagnetpackagetoolsandbox(context, component, toolMetadata, diagnostics);
	if (!processRuntime || !sandbox || !component.path) return [];

	const namePrefix = asString(descriptor.name_prefix) ?? asString(descriptor.namePrefix);
	const descriptorEnv = mcpEnvFromDescriptor(descriptor.env);
	const clientEnv = descriptorEnv ? { ...process.env, ...descriptorEnv } : process.env;
	const resolvedCommand = resolvePackageCommand(component, command, diagnostics);
	if (!resolvedCommand) return [];
	try {
		const discovered = await discoverMcpTools({
			serverName: asString(descriptor.name) ?? component.name,
			namePrefix,
			client: {
				command: resolvedCommand,
				args: asStringArray(descriptor.args),
				cwd: dirname(component.path),
				env: clientEnv,
				requestTimeoutMs: asNumber(descriptor.timeout_ms),
				spawnManaged: (input, signal) =>
					processRuntime.spawnManaged(
						{
							command: input.command,
							args: input.args,
							cwd: input.cwd ?? dirname(component.path!),
							workspace_root: component.packageDir,
							env_overrides: Object.fromEntries(
								Object.entries(input.env ?? {}).filter(
									(entry): entry is [string, string] => typeof entry[1] === "string",
								),
							),
							sandbox,
							tool: toolMetadata,
						},
						signal,
					),
			},
			cache: {
				dir: resolve(context.repoRoot, ".magenta", "cache", "mcp"),
				descriptorEnv,
			},
		});
		if (discovered.tools.length === 0) {
			await discovered.connection.close();
			return [];
		}
		return discovered.tools.map((tool) => ({
			...settings,
			mcp: { connection: discovered.connection, tool, namePrefix },
			toolName: mcpToolName(tool.name, namePrefix),
		}));
	} catch (error) {
		const message = formatUnknownError(error);
		const notStarted = /ENOENT|not found|no such file|spawn\b/i.test(message);
		diagnostics.push({
			type: notStarted ? "warning" : "error",
			code: "package_tool_runtime_missing",
			message: notStarted
				? `Package ${component.packageId} MCP tool ${component.name}: server binary not available (${resolvedCommand}). Build it, then reload. Original error: ${message}`
				: `Package ${component.packageId} MCP tool ${component.name} failed to connect to MCP server: ${message}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return [];
	}
}

export async function createPackageToolProduct(
	options: CreatePackageToolProductOptions,
): Promise<CreatePackageToolProductResult> {
	const { component, context } = options;
	const diagnostics: PackageToolDiagnostic[] = [];

	const descriptor = await readPackageToolDescriptor(component, diagnostics);
	if (!descriptor || !component.path) return { diagnostics };

	const execution = asString(descriptor.execution);
	if (execution === "declarative") {
		return { diagnostics };
	}

	const name = asString(descriptor.name) ?? component.name;
	const description = asString(descriptor.description) ?? component.description ?? name;
	const parameters = parametersFromToml(descriptor.parameters);
	const runtime = asString(descriptor.runtime) ?? asString(descriptor.kind);
	const toolMetadata = toolMetadataFromDescriptor(name, descriptor);
	if (!runtime) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} tool ${component.name} descriptor must declare runtime or kind.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { diagnostics };
	}

	const sandbox = HcpMagnetpackagetoolsandbox(context, component, toolMetadata, diagnostics);
	if (!sandbox) return { diagnostics };

	if (runtime === "mcp") {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} MCP tool ${component.name} was not expanded before assembly.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { diagnostics };
	}

	if (runtime === "process") {
		const processRuntime = HcpMagnetpackagetoolprocessruntime(context, component, diagnostics);
		if (!processRuntime) return { diagnostics };
		const command = asString(descriptor.command);
		if (!command) {
			diagnostics.push({
				type: "error",
				code: "package_tool_descriptor_invalid",
				message: `Package ${component.packageId} process tool ${component.name} must declare command.`,
				path: component.path,
				packageId: component.packageId,
				profile: component.profile,
			});
			return { diagnostics };
		}
		const resolvedCommand = resolvePackageCommand(component, command, diagnostics);
		if (!resolvedCommand) return { diagnostics };
		const fixedArgs = asStringArray(descriptor.args);
		const descriptorPath = component.path;
		const tool = new ProcessTool({
			name,
			description,
			parameters,
			buildInvocation: (params) => ({
				command: resolvedCommand,
				args: [...fixedArgs, ...processArgsFromParams(params)],
				cwd: dirname(descriptorPath),
				workspaceRoot: component.packageDir,
				timeoutMs: asNumber(descriptor.timeout_ms),
			}),
			toolMetadata,
			sandbox,
			runtimeExec: processRuntime.exec.bind(processRuntime),
		});
		return {
			diagnostics,
			product: tool,
		};
	}

	const runtimeComponent = context.componentMap.get(`python-runtime:${runtime}`);
	if (runtimeComponent) {
		const processRuntime = HcpMagnetpackagetoolprocessruntime(context, component, diagnostics);
		if (!processRuntime) return { diagnostics };
		const pythonLauncher = resolvePythonLauncher(component, context, descriptor, diagnostics);
		if (!asString(descriptor.python_bin) && !pythonLauncher) return { diagnostics };
		const module = asString(descriptor.module) ?? runtime;
		const modulePath =
			asString(descriptor.module_path) ?? runtimeComponentRelativePath(component.packageDir, runtimeComponent);
		const tool = new PythonModuleTool({
			name,
			description,
			parameters,
			module,
			modulePath,
			packageDir: component.packageDir,
			descriptorPath: component.path,
			pythonBin: asString(descriptor.python_bin),
			pythonLauncher,
			workspaceRoot: context.repoRoot,
			timeoutMs: asNumber(descriptor.timeout_ms),
			toolMetadata,
			sandbox,
			runtimeExec: processRuntime.exec.bind(processRuntime),
		});
		return {
			diagnostics,
			product: tool,
		};
	}

	const scriptRuntimeName = runtime.startsWith("runtime://") ? runtime.slice("runtime://".length) : runtime;
	const scriptRuntime = context.resolveCapability<ScriptRuntimeProvider>("runtime:script-runtimes");
	let scriptRuntimeDescription: ReturnType<ScriptRuntimeProvider["describeRuntime"]> | undefined;
	try {
		scriptRuntimeDescription = scriptRuntime?.describeRuntime(scriptRuntimeName);
	} catch {
		// Unsupported names fall through to the normal missing-runtime diagnostic.
	}
	if (scriptRuntime && scriptRuntimeDescription) {
		const code = await scriptCodeFromDescriptor(component, descriptor, diagnostics);
		if (!code) return { diagnostics };
		const fixedArgs = asStringArray(descriptor.args);
		const descriptorPath = component.path;
		const tool = new ProcessTool(
			{
				name,
				description,
				parameters,
				buildInvocation: (params) => ({
					command: scriptRuntimeDescription.command,
					args: fixedArgs,
					cwd: dirname(descriptorPath),
					workspaceRoot: component.packageDir,
					policyInput: params ?? {},
					timeoutMs: asNumber(descriptor.timeout_ms),
				}),
				toolMetadata,
				sandbox,
				runtimeExec: (input, signal) =>
					scriptRuntime.execRuntime(
						scriptRuntimeName,
						{
							code,
							args: input.args,
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
					),
			},
			`script:${scriptRuntimeName}`,
		);
		return {
			diagnostics,
			product: tool,
		};
	}

	if (context.componentMap.has(`runtime:${runtime}`) || context.componentMap.has(`process-runtime:${runtime}`)) {
		diagnostics.push({
			type: "error",
			code: "package_tool_runtime_unsupported",
			message: `Package ${component.packageId} tool ${component.name} declares unsupported runtime ${runtime}.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { diagnostics };
	}

	diagnostics.push({
		type: "error",
		code: "package_tool_runtime_missing",
		message: `Package ${component.packageId} tool ${component.name} references missing runtime ${runtime}.`,
		path: component.path,
		packageId: component.packageId,
		profile: component.profile,
	});
	return { diagnostics };
}

async function scriptCodeFromDescriptor(
	component: PackageToolComponent,
	descriptor: TomlTable,
	diagnostics: PackageToolDiagnostic[],
): Promise<string | undefined> {
	const inline = asString(descriptor.code) ?? asString(descriptor.script);
	if (inline !== undefined) {
		if (inline.trim() === "") {
			diagnostics.push({
				type: "error",
				code: "package_tool_descriptor_invalid",
				message: `Package ${component.packageId} script tool ${component.name} declares empty code.`,
				path: component.path,
				packageId: component.packageId,
				profile: component.profile,
			});
			return undefined;
		}
		return inline;
	}

	const scriptPath = asString(descriptor.script_path) ?? asString(descriptor.scriptPath);
	if (!scriptPath) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} script tool ${component.name} must declare code or script_path.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
	if (isAbsolute(scriptPath)) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} script tool ${component.name} script_path must be package-local: ${scriptPath}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}

	const packageDir = component.packageDir;
	const resolvedScriptPath = resolve(dirname(component.path!), scriptPath);
	if (!isWithinDir(packageDir, resolvedScriptPath)) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} script tool ${component.name} script_path escapes the package directory: ${scriptPath}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}

	try {
		const code = await readFile(resolvedScriptPath, "utf-8");
		if (code.trim() === "") {
			diagnostics.push({
				type: "error",
				code: "package_tool_descriptor_invalid",
				message: `Package ${component.packageId} script tool ${component.name} script_path is empty: ${scriptPath}`,
				path: resolvedScriptPath,
				packageId: component.packageId,
				profile: component.profile,
			});
			return undefined;
		}
		return code;
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_read_failed",
			message: `Unable to read package script ${resolvedScriptPath}: ${formatUnknownError(error)}`,
			path: resolvedScriptPath,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
}

function isWithinDir(parentDir: string, childPath: string): boolean {
	const rel = relative(parentDir, childPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toolMetadataFromDescriptor(name: string, descriptor: TomlTable) {
	return {
		name,
		operation: asString(descriptor.operation),
		read_only: asBoolean(descriptor.read_only) ?? false,
		destructive: asBoolean(descriptor.destructive) ?? false,
		tags: asStringArray(descriptor.tags),
	};
}

function HcpMagnetpackagetoolsandbox(
	context: PackageToolContext,
	component: PackageToolComponent,
	toolMetadata: ReturnType<typeof toolMetadataFromDescriptor>,
	diagnostics: PackageToolDiagnostic[],
): ReturnType<SandboxProvider["resolve"]> | undefined {
	const provider = context.resolveCapability<SandboxProvider>("sandbox");
	if (provider) return provider.resolve({ tool: toolMetadata });
	diagnostics.push({
		type: "error",
		code: "package_tool_sandbox_missing",
		message: `Package ${component.packageId} tool ${component.name} requires selected capability sandbox.`,
		path: component.path,
		packageId: component.packageId,
		profile: component.profile,
	});
	return undefined;
}

function HcpMagnetpackagetoolprocessruntime(
	context: PackageToolContext,
	component: PackageToolComponent,
	diagnostics: PackageToolDiagnostic[],
): ProcessRuntimeProvider | undefined {
	const provider = context.resolveCapability<ProcessRuntimeProvider>("runtime:process");
	if (provider) return provider;
	diagnostics.push({
		type: "error",
		code: "package_tool_runtime_missing",
		message: `Package ${component.packageId} tool ${component.name} requires selected capability runtime:process.`,
		path: component.path,
		packageId: component.packageId,
		profile: component.profile,
	});
	return undefined;
}

function resolvePythonLauncher(
	component: PackageToolComponent,
	context: PackageToolContext,
	descriptor: TomlTable,
	diagnostics: PackageToolDiagnostic[],
): PythonLauncherResolver | undefined {
	if (asString(descriptor.python_bin)) return undefined;
	const pixiManifest = findPackageEnvComponent(context, component, "env", "pixi");
	if (!pixiManifest?.path) {
		diagnostics.push({
			type: "error",
			code: "package_tool_environment_missing",
			message: `Package ${component.packageId} Python tool ${component.name} requires python_bin or a package env:pixi component.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
	const pixiManifestPath = pixiManifest.path;
	const defaultEnvironment = pixiEnvironmentName(descriptor);
	const environmentsByModality = pixiEnvironmentsByModality(descriptor);
	return (params) => {
		const modality = typeof params.modality === "string" ? params.modality : undefined;
		const environment = (modality ? environmentsByModality[modality] : undefined) ?? defaultEnvironment;
		const argsPrefix: string[] = ["run", "--manifest-path", pixiManifestPath, "--frozen"];
		if (environment) argsPrefix.push("--environment", environment);
		argsPrefix.push("--executable", "python");
		return { command: "pixi", argsPrefix };
	};
}

function findPackageEnvComponent(
	context: PackageToolContext,
	component: PackageToolComponent,
	kind: string,
	name: string,
): PackageToolRuntimeComponent | undefined {
	return context.components.find(
		(candidate) =>
			candidate.packageId === component.packageId &&
			candidate.kind === kind &&
			candidate.name === name &&
			Boolean(candidate.path),
	);
}

function pixiEnvironmentName(descriptor: TomlTable): string | undefined {
	const explicit = asString(descriptor.pixi_environment) ?? asString(descriptor.environment);
	if (explicit) return explicit;
	const metadata = isPlainRecord(descriptor.metadata) ? descriptor.metadata : undefined;
	return asString(metadata?.pixi_environment) ?? asString(metadata?.environment);
}

function pixiEnvironmentsByModality(descriptor: TomlTable): Record<string, string> {
	const table = isPlainRecord(descriptor.pixi_environment_by_modality)
		? descriptor.pixi_environment_by_modality
		: undefined;
	const metadata = isPlainRecord(descriptor.metadata) ? descriptor.metadata : undefined;
	const metadataTable = isPlainRecord(metadata?.pixi_environment_by_modality)
		? metadata.pixi_environment_by_modality
		: undefined;
	const source = table ?? metadataTable ?? {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		const environment = asString(value);
		if (environment) result[key] = environment;
	}
	return result;
}

function processArgsFromParams(params: unknown): string[] {
	if (Array.isArray(params)) return params.map(String);
	if (!isPlainRecord(params)) return [];
	const rawArgs = params.args;
	const args = Array.isArray(rawArgs) ? rawArgs.map(String) : isPlainRecord(rawArgs) ? flagsFromRecord(rawArgs) : [];
	args.push(...flagsFromRecord(params, new Set(["args"])));
	return args;
}

function flagsFromRecord(record: Record<string, unknown>, exclude = new Set<string>()): string[] {
	return Object.entries(record).flatMap(([key, value]) => {
		if (exclude.has(key)) return [];
		if (key === "args" || value === undefined || value === null) return [];
		const flag = `--${kebabCase(key)}`;
		if (typeof value === "boolean") return value ? [flag] : [];
		if (Array.isArray(value)) return value.flatMap((item) => [flag, String(item)]);
		return [flag, String(value)];
	});
}

function runtimeComponentRelativePath(packageDir: string, component: PackageToolRuntimeComponent): string | undefined {
	if (!component.path) return undefined;
	const rel = relative(packageDir, dirname(component.path));
	return rel.startsWith("..") ? undefined : rel;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readPackageToolDescriptor(
	component: PackageToolComponent,
	diagnostics: PackageToolDiagnostic[],
): Promise<TomlTable | undefined> {
	if (!component.path) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_missing",
			message: `Package ${component.packageId} tool ${component.name} has no descriptor path.`,
			path: component.sourcePath,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
	try {
		return parseToml(await readFile(component.path, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_read_failed",
			message: `Unable to read package tool descriptor ${component.path}: ${formatUnknownError(error)}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
}

/** Resolve a package command without inventing a path from its manifest id. */
function resolvePackageCommand(
	component: PackageToolComponent,
	command: string,
	diagnostics: PackageToolDiagnostic[],
): string | undefined {
	if (isAbsolute(command)) return command;
	if (!(command.includes("/") || command.includes("\\"))) return command;
	const resolvedCommand = resolve(dirname(component.path!), command);
	if (isWithinDir(component.packageDir, resolvedCommand)) return resolvedCommand;
	diagnostics.push({
		type: "error",
		code: "package_tool_descriptor_invalid",
		message: `Package ${component.packageId} tool ${component.name} command escapes the package directory: ${command}`,
		path: component.path,
		packageId: component.packageId,
		profile: component.profile,
	});
	return undefined;
}

/** Read an optional `[env]` table from an MCP descriptor into string pairs. */
function mcpEnvFromDescriptor(value: unknown): Record<string, string> | undefined {
	if (!isPlainRecord(value)) return undefined;
	const env: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string") env[key] = raw;
		else if (typeof raw === "number" || typeof raw === "boolean") env[key] = String(raw);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function kebabCase(value: string): string {
	return value
		.replace(/_/g, "-")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase();
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
