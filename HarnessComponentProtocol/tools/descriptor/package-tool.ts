import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parametersFromToml } from "../../_magenta/mcp/schema.ts";
import { discoverMcpTools, McpTool, type McpToolOptions, mcpToolName } from "../../_magenta/mcp/tool.ts";
import type { HcpClientpackagetooldiagnostic } from "../../_magenta/packages/tool-diagnostic.ts";
import { parseToml, type TomlTable } from "../../_magenta/utils/pi/toml.ts";
import type { ProcessRuntimeProvider, ScriptRuntimeProvider } from "../../runtime/HcpServer.ts";
import type { SandboxProvider } from "../../sandbox/HcpServer.ts";
import { ProcessTool } from "../process-tool.ts";
import { type PythonLauncherResolver, PythonModuleTool } from "../python-module-tool.ts";

export type {
	HcpClientpackagetooldiagnostic,
	HcpClientpackagetooldiagnosticcode,
} from "../../_magenta/packages/tool-diagnostic.ts";

export type HcpClientpackagetoolcomponent = {
	packageId: string;
	packageDir: string;
	profile?: string;
	kind: string;
	name: string;
	description?: string;
	path?: string;
	sourcePath: string;
};

export type HcpClientpackagetoolruntimecomponent = {
	packageId: string;
	packageDir: string;
	kind: string;
	name: string;
	path?: string;
};

export type HcpClientpackagetoolcontext = {
	resolveCapability<T>(name: string): T | undefined;
	repoRoot: string;
	components: HcpClientpackagetoolruntimecomponent[];
	componentMap: Map<string, HcpClientpackagetoolruntimecomponent>;
};

export type HcpClientpackagetoolproductoptions = {
	component: HcpClientpackagetoolcomponent;
	context: HcpClientpackagetoolcontext;
};

export type HcpClientpackagetoolproductresult = {
	product?: HcpClientpackagetoolproduct;
	diagnostics: HcpClientpackagetooldiagnostic[];
};

export type HcpClientpackagetoolproduct = {
	readonly kind: string;
	readonly source?: string;
	toTool(): AgentTool;
	close?(): void | Promise<void>;
};

export type HcpClientpackagetoolbuildsettings = {
	component: HcpClientpackagetoolcomponent;
	components: HcpClientpackagetoolruntimecomponent[];
	componentMap: Map<string, HcpClientpackagetoolruntimecomponent>;
	diagnostics: HcpClientpackagetooldiagnostic[];
	mcp?: McpToolOptions;
	toolName?: string;
};

/** Build host-backed Tool products while leaving Source ownership to the caller's real HcpMagnet. */
export async function HcpClientbuildpackagetoolproducts(
	settings: HcpClientpackagetoolbuildsettings,
	context: HcpClientpackagetoolcontext,
): Promise<HcpClientpackagetoolproduct[]> {
	const expanded = await HcpClientexpandpackagetoolbuildsettings(settings, context);
	const products: HcpClientpackagetoolproduct[] = [];
	try {
		for (const expandedSettings of expanded) {
			if (expandedSettings.mcp) {
				products.push(new McpTool({ ...expandedSettings.mcp, terminalOnLastRelease: true }));
				continue;
			}
			const result = await HcpClientcreatepackagetoolproduct({
				component: expandedSettings.component,
				context,
			});
			settings.diagnostics.push(...result.diagnostics);
			if (result.product) products.push(result.product);
		}
		return products;
	} catch (error) {
		await Promise.allSettled(products.map((product) => product.close?.()));
		await HcpClientcloseexpandedpackageconnections(expanded);
		throw error;
	}
}

async function HcpClientcloseexpandedpackageconnections(
	settings: readonly HcpClientpackagetoolbuildsettings[],
): Promise<void> {
	const connections = new Set(
		settings.map((entry) => entry.mcp?.connection).filter((connection) => connection !== undefined),
	);
	await Promise.all(
		[...connections].map(async (connection) => {
			try {
				await connection.close();
			} catch {
				// Preserve the Source build error; cleanup is best-effort.
			}
		}),
	);
}

/** Expand one MCP server descriptor into one single-product build setting per remote tool. */
export async function HcpClientexpandpackagetoolbuildsettings(
	settings: HcpClientpackagetoolbuildsettings,
	context: HcpClientpackagetoolcontext,
): Promise<HcpClientpackagetoolbuildsettings[]> {
	const { component, diagnostics } = settings;
	const descriptor = await HcpClientreadpackagetooldescriptor(component, diagnostics);
	if (!descriptor) return [];
	const runtime = HcpClientasstring(descriptor.runtime) ?? HcpClientasstring(descriptor.kind);
	if (runtime !== "mcp") return [settings];

	const command = HcpClientpackagetoolcommand(descriptor);
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
	const processRuntime = HcpClientpackagetoolprocessruntime(context, component, diagnostics);
	const toolMetadata = HcpClienttoolmetadatafromdescriptor(
		HcpClientasstring(descriptor.name) ?? component.name,
		descriptor,
	);
	const sandbox = HcpClientpackagetoolsandbox(context, component, toolMetadata, diagnostics);
	if (!processRuntime || !sandbox || !component.path) return [];

	const namePrefix = HcpClientasstring(descriptor.name_prefix) ?? HcpClientasstring(descriptor.namePrefix);
	const descriptorEnv = HcpClientmcpenvfromdescriptor(descriptor.env);
	const clientEnv = descriptorEnv ? { ...process.env, ...descriptorEnv } : process.env;
	const resolvedCommand = HcpClientresolvepackagecommand(component, command, diagnostics);
	if (!resolvedCommand) return [];
	try {
		const discovered = await discoverMcpTools({
			serverName: HcpClientasstring(descriptor.name) ?? component.name,
			namePrefix,
			client: {
				command: resolvedCommand,
				args: HcpClientasstringarray(descriptor.args),
				cwd: dirname(component.path),
				env: clientEnv,
				requestTimeoutMs: HcpClientasnumber(descriptor.timeout_ms),
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
		const message = HcpClientformatunknownerror(error);
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

export async function HcpClientcreatepackagetoolproduct(
	options: HcpClientpackagetoolproductoptions,
): Promise<HcpClientpackagetoolproductresult> {
	const { component, context } = options;
	const diagnostics: HcpClientpackagetooldiagnostic[] = [];

	const descriptor = await HcpClientreadpackagetooldescriptor(component, diagnostics);
	if (!descriptor || !component.path) return { diagnostics };

	const execution = HcpClientasstring(descriptor.execution);
	if (execution === "declarative") {
		return { diagnostics };
	}

	const name = HcpClientasstring(descriptor.name) ?? component.name;
	const description = HcpClientasstring(descriptor.description) ?? component.description ?? name;
	const parameters = parametersFromToml(descriptor.parameters);
	const runtime = HcpClientasstring(descriptor.runtime) ?? HcpClientasstring(descriptor.kind);
	const toolMetadata = HcpClienttoolmetadatafromdescriptor(name, descriptor);
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

	const sandbox = HcpClientpackagetoolsandbox(context, component, toolMetadata, diagnostics);
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
		const processRuntime = HcpClientpackagetoolprocessruntime(context, component, diagnostics);
		if (!processRuntime) return { diagnostics };
		const command = HcpClientpackagetoolcommand(descriptor);
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
		const resolvedCommand = HcpClientresolvepackagecommand(component, command, diagnostics);
		if (!resolvedCommand) return { diagnostics };
		const fixedArgs = HcpClientasstringarray(descriptor.args);
		const descriptorPath = component.path;
		const tool = new ProcessTool({
			name,
			description,
			parameters,
			buildInvocation: (params) => ({
				command: resolvedCommand,
				args: [...fixedArgs, ...HcpClientprocessargsfromparams(params)],
				cwd: dirname(descriptorPath),
				workspaceRoot: component.packageDir,
				timeoutMs: HcpClientasnumber(descriptor.timeout_ms),
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
		const processRuntime = HcpClientpackagetoolprocessruntime(context, component, diagnostics);
		if (!processRuntime) return { diagnostics };
		const pythonLauncher = HcpClientresolvepythonlauncher(component, context, descriptor, diagnostics);
		if (!HcpClientasstring(descriptor.python_bin) && !pythonLauncher) return { diagnostics };
		const module = HcpClientasstring(descriptor.module) ?? runtime;
		const modulePath =
			HcpClientasstring(descriptor.module_path) ??
			HcpClientruntimecomponentrelativepath(component.packageDir, runtimeComponent);
		const tool = new PythonModuleTool({
			name,
			description,
			parameters,
			module,
			modulePath,
			packageDir: component.packageDir,
			descriptorPath: component.path,
			pythonBin: HcpClientasstring(descriptor.python_bin),
			pythonLauncher,
			workspaceRoot: context.repoRoot,
			timeoutMs: HcpClientasnumber(descriptor.timeout_ms),
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
		const code = await HcpClientscriptcodefromdescriptor(component, descriptor, diagnostics);
		if (!code) return { diagnostics };
		const fixedArgs = HcpClientasstringarray(descriptor.args);
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
					timeoutMs: HcpClientasnumber(descriptor.timeout_ms),
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

async function HcpClientscriptcodefromdescriptor(
	component: HcpClientpackagetoolcomponent,
	descriptor: TomlTable,
	diagnostics: HcpClientpackagetooldiagnostic[],
): Promise<string | undefined> {
	const inline = HcpClientasstring(descriptor.code) ?? HcpClientasstring(descriptor.script);
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

	const scriptPath = HcpClientasstring(descriptor.script_path) ?? HcpClientasstring(descriptor.scriptPath);
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
	if (!HcpClientiswithindir(packageDir, resolvedScriptPath)) {
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
			message: `Unable to read package script ${resolvedScriptPath}: ${HcpClientformatunknownerror(error)}`,
			path: resolvedScriptPath,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
}

function HcpClientiswithindir(parentDir: string, childPath: string): boolean {
	const rel = relative(parentDir, childPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function HcpClienttoolmetadatafromdescriptor(name: string, descriptor: TomlTable) {
	return {
		name,
		operation: HcpClientasstring(descriptor.operation),
		read_only: HcpClientasboolean(descriptor.read_only) ?? false,
		destructive: HcpClientasboolean(descriptor.destructive) ?? false,
		tags: HcpClientasstringarray(descriptor.tags),
	};
}

function HcpClientpackagetoolsandbox(
	context: HcpClientpackagetoolcontext,
	component: HcpClientpackagetoolcomponent,
	toolMetadata: ReturnType<typeof HcpClienttoolmetadatafromdescriptor>,
	diagnostics: HcpClientpackagetooldiagnostic[],
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

function HcpClientpackagetoolprocessruntime(
	context: HcpClientpackagetoolcontext,
	component: HcpClientpackagetoolcomponent,
	diagnostics: HcpClientpackagetooldiagnostic[],
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

function HcpClientresolvepythonlauncher(
	component: HcpClientpackagetoolcomponent,
	context: HcpClientpackagetoolcontext,
	descriptor: TomlTable,
	diagnostics: HcpClientpackagetooldiagnostic[],
): PythonLauncherResolver | undefined {
	if (HcpClientasstring(descriptor.python_bin)) return undefined;
	const pixiManifest = HcpClientfindpackageenvcomponent(context, component, "env", "pixi");
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
	const defaultEnvironment = HcpClientpixienvironmentname(descriptor);
	const environmentsByModality = HcpClientpixienvironmentsbymodality(descriptor);
	return (params) => {
		const modality = typeof params.modality === "string" ? params.modality : undefined;
		const environment = (modality ? environmentsByModality[modality] : undefined) ?? defaultEnvironment;
		const argsPrefix: string[] = ["run", "--manifest-path", pixiManifestPath, "--frozen"];
		if (environment) argsPrefix.push("--environment", environment);
		argsPrefix.push("--executable", "python");
		return { command: "pixi", argsPrefix };
	};
}

function HcpClientfindpackageenvcomponent(
	context: HcpClientpackagetoolcontext,
	component: HcpClientpackagetoolcomponent,
	kind: string,
	name: string,
): HcpClientpackagetoolruntimecomponent | undefined {
	return context.components.find(
		(candidate) =>
			candidate.packageId === component.packageId &&
			candidate.kind === kind &&
			candidate.name === name &&
			Boolean(candidate.path),
	);
}

function HcpClientpixienvironmentname(descriptor: TomlTable): string | undefined {
	const explicit = HcpClientasstring(descriptor.pixi_environment) ?? HcpClientasstring(descriptor.environment);
	if (explicit) return explicit;
	const metadata = HcpClientisplainrecord(descriptor.metadata) ? descriptor.metadata : undefined;
	return HcpClientasstring(metadata?.pixi_environment) ?? HcpClientasstring(metadata?.environment);
}

function HcpClientpixienvironmentsbymodality(descriptor: TomlTable): Record<string, string> {
	const table = HcpClientisplainrecord(descriptor.pixi_environment_by_modality)
		? descriptor.pixi_environment_by_modality
		: undefined;
	const metadata = HcpClientisplainrecord(descriptor.metadata) ? descriptor.metadata : undefined;
	const metadataTable = HcpClientisplainrecord(metadata?.pixi_environment_by_modality)
		? metadata.pixi_environment_by_modality
		: undefined;
	const source = table ?? metadataTable ?? {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		const environment = HcpClientasstring(value);
		if (environment) result[key] = environment;
	}
	return result;
}

function HcpClientprocessargsfromparams(params: unknown): string[] {
	if (Array.isArray(params)) return params.map(String);
	if (!HcpClientisplainrecord(params)) return [];
	const rawArgs = params.args;
	const args = Array.isArray(rawArgs)
		? rawArgs.map(String)
		: HcpClientisplainrecord(rawArgs)
			? HcpClientflagsfromrecord(rawArgs)
			: [];
	args.push(...HcpClientflagsfromrecord(params, new Set(["args"])));
	return args;
}

function HcpClientflagsfromrecord(record: Record<string, unknown>, exclude = new Set<string>()): string[] {
	return Object.entries(record).flatMap(([key, value]) => {
		if (exclude.has(key)) return [];
		if (key === "args" || value === undefined || value === null) return [];
		const flag = `--${HcpClientkebabcase(key)}`;
		if (typeof value === "boolean") return value ? [flag] : [];
		if (Array.isArray(value)) return value.flatMap((item) => [flag, String(item)]);
		return [flag, String(value)];
	});
}

function HcpClientruntimecomponentrelativepath(
	packageDir: string,
	component: HcpClientpackagetoolruntimecomponent,
): string | undefined {
	if (!component.path) return undefined;
	const rel = relative(packageDir, dirname(component.path));
	return rel.startsWith("..") ? undefined : rel;
}

function HcpClientasstring(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function HcpClientasboolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function HcpClientasnumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function HcpClientasstringarray(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function HcpClientisplainrecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function HcpClientreadpackagetooldescriptor(
	component: HcpClientpackagetoolcomponent,
	diagnostics: HcpClientpackagetooldiagnostic[],
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
			message: `Unable to read package tool descriptor ${component.path}: ${HcpClientformatunknownerror(error)}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return undefined;
	}
}

/** Resolve a package command without inventing a path from its manifest id. */
function HcpClientresolvepackagecommand(
	component: HcpClientpackagetoolcomponent,
	command: string,
	diagnostics: HcpClientpackagetooldiagnostic[],
): string | undefined {
	if (isAbsolute(command)) return command;
	if (!(command.includes("/") || command.includes("\\"))) return command;
	const resolvedCommand = resolve(dirname(component.path!), command);
	if (HcpClientiswithindir(component.packageDir, resolvedCommand)) return resolvedCommand;
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

/** Select an optional host-platform command before falling back to `command`. */
export function HcpClientpackagetoolcommand(
	descriptor: TomlTable,
	hostPlatform: NodeJS.Platform = process.platform,
): string | undefined {
	const platformKeys =
		hostPlatform === "win32"
			? ["command_windows", "commandWindows"]
			: hostPlatform === "darwin"
				? ["command_macos", "commandMacos"]
				: hostPlatform === "linux"
					? ["command_linux", "commandLinux"]
					: [];
	for (const key of platformKeys) {
		const command = HcpClientasstring(descriptor[key]);
		if (command) return command;
	}
	return HcpClientasstring(descriptor.command);
}

/** Read an optional `[env]` table from an MCP descriptor into string pairs. */
function HcpClientmcpenvfromdescriptor(value: unknown): Record<string, string> | undefined {
	if (!HcpClientisplainrecord(value)) return undefined;
	const env: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string") env[key] = raw;
		else if (typeof raw === "number" || typeof raw === "boolean") env[key] = String(raw);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function HcpClientkebabcase(value: string): string {
	return value
		.replace(/_/g, "-")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase();
}

function HcpClientformatunknownerror(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
