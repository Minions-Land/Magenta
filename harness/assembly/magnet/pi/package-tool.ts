import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Magnet } from "./magnet.ts";
import { ProcessToolMagnet } from "./process.ts";
import { PythonModuleToolMagnet, type PythonLauncherResolver } from "./python.ts";
import { parametersFromToml } from "./schema.ts";
import { parseToml, type TomlTable } from "../../registry/pi/registry.ts";
import { execScriptRuntime, SCRIPT_RUNTIME_SPECS, type RuntimeSpec } from "../../../runtime/magenta/script-runtime.ts";
import {
	loadSandboxProviderFromPack,
	type SandboxProfile,
	type SandboxSelection,
	selectSandboxProfile,
} from "../../../sandbox/magenta/sandbox.ts";

export type PackageToolMagnetDiagnosticCode =
	| "package_tool_descriptor_missing"
	| "package_tool_descriptor_read_failed"
	| "package_tool_descriptor_invalid"
	| "package_tool_environment_missing"
	| "package_tool_runtime_missing"
	| "package_tool_runtime_unsupported";

export interface PackageToolMagnetDiagnostic {
	type: "warning" | "error";
	code: PackageToolMagnetDiagnosticCode;
	message: string;
	path?: string;
	packageId?: string;
	profile?: string;
}

export interface PackageToolMagnetComponent {
	packageId: string;
	profile?: string;
	kind: string;
	name: string;
	description?: string;
	path?: string;
	sourcePath: string;
}

export interface PackageToolRuntimeComponent {
	packageId: string;
	kind: string;
	name: string;
	path?: string;
}

export interface PackageToolMagnetContext {
	repoRoot: string;
	packagesRoot: string;
	components: PackageToolRuntimeComponent[];
	componentMap: Map<string, PackageToolRuntimeComponent>;
}

export interface CreatePackageToolMagnetOptions {
	component: PackageToolMagnetComponent;
	context: PackageToolMagnetContext;
}

export interface CreatePackageToolMagnetResult {
	magnet?: Magnet;
	diagnostics: PackageToolMagnetDiagnostic[];
}

export async function createPackageToolMagnet(
	options: CreatePackageToolMagnetOptions,
): Promise<CreatePackageToolMagnetResult> {
	const { component, context } = options;
	const diagnostics: PackageToolMagnetDiagnostic[] = [];

	if (!component.path) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_missing",
			message: `Package ${component.packageId} tool ${component.name} has no descriptor path.`,
			path: component.sourcePath,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { diagnostics };
	}

	let descriptor: TomlTable;
	try {
		descriptor = parseToml(await readFile(component.path, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_read_failed",
			message: `Unable to read package tool descriptor ${component.path}: ${formatUnknownError(error)}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { diagnostics };
	}

	const execution = asString(descriptor.execution);
	if (execution === "declarative") {
		return { diagnostics };
	}

	const name = asString(descriptor.name) ?? component.name;
	const description = asString(descriptor.description) ?? component.description ?? name;
	const parameters = parametersFromToml(descriptor.parameters);
	const runtime = asString(descriptor.runtime) ?? asString(descriptor.magnet) ?? asString(descriptor.kind);
	const toolMetadata = toolMetadataFromDescriptor(name, descriptor);
	const sandbox = await resolvePackageToolSandbox(context, toolMetadata);

	if (!runtime) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package ${component.packageId} tool ${component.name} descriptor must declare runtime, magnet, or kind.`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { diagnostics };
	}

	if (runtime === "process") {
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
		const fixedArgs = asStringArray(descriptor.args);
		const descriptorPath = component.path;
		return {
			diagnostics,
			magnet: new ProcessToolMagnet({
				name,
				description,
				parameters,
				buildInvocation: (params) => ({
					command,
					args: [...fixedArgs, ...processArgsFromParams(params)],
					cwd: dirname(descriptorPath),
					workspaceRoot: context.repoRoot,
					timeoutMs: asNumber(descriptor.timeout_ms),
				}),
				toolMetadata,
				sandbox,
			}),
		};
	}

	const runtimeComponent = context.componentMap.get(`python-runtime:${runtime}`);
	if (runtimeComponent) {
		const pythonLauncher = resolvePythonLauncher(component, context, descriptor, diagnostics);
		if (!asString(descriptor.python_bin) && !pythonLauncher) return { diagnostics };
		const module = asString(descriptor.module) ?? runtime;
		const modulePath =
			asString(descriptor.module_path) ??
			runtimeComponentRelativePath(resolve(context.packagesRoot, component.packageId), runtimeComponent);
		return {
			diagnostics,
			magnet: new PythonModuleToolMagnet({
				name,
				description,
				parameters,
				module,
				modulePath,
				packageDir: resolve(context.packagesRoot, component.packageId),
				descriptorPath: component.path,
				pythonBin: asString(descriptor.python_bin),
				pythonLauncher,
				workspaceRoot: context.repoRoot,
				timeoutMs: asNumber(descriptor.timeout_ms),
				toolMetadata,
				sandbox,
			}),
		};
	}

	const scriptSpec = scriptRuntimeSpec(runtime);
	if (scriptSpec) {
		const code = await scriptCodeFromDescriptor(component, context, descriptor, diagnostics);
		if (!code) return { diagnostics };
		const fixedArgs = asStringArray(descriptor.args);
		const descriptorPath = component.path;
		return {
			diagnostics,
			magnet: new ProcessToolMagnet(
				{
						name,
						description,
						parameters,
						buildInvocation: (params) => ({
							command: scriptSpec.command,
							args: fixedArgs,
							cwd: dirname(descriptorPath),
							workspaceRoot: context.repoRoot,
							policyInput: params ?? {},
							timeoutMs: asNumber(descriptor.timeout_ms),
					}),
					toolMetadata,
					sandbox,
					runtimeExec: (input, signal) =>
						execScriptRuntime(
							scriptSpec,
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
				`script:${scriptSpec.name}`,
			),
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

function scriptRuntimeSpec(runtime: string): RuntimeSpec | undefined {
	const name = runtime.startsWith("runtime://") ? runtime.slice("runtime://".length) : runtime;
	return SCRIPT_RUNTIME_SPECS.find((spec) => spec.name === name);
}

async function scriptCodeFromDescriptor(
	component: PackageToolMagnetComponent,
	context: PackageToolMagnetContext,
	descriptor: TomlTable,
	diagnostics: PackageToolMagnetDiagnostic[],
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

	const packageDir = resolve(context.packagesRoot, component.packageId);
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

async function resolvePackageToolSandbox(
	context: PackageToolMagnetContext,
	toolMetadata: ReturnType<typeof toolMetadataFromDescriptor>,
): Promise<{ selection: SandboxSelection; profile?: SandboxProfile }> {
	const selection = selectSandboxProfile({ tool: toolMetadata });
	const sandboxPackPath = resolveSandboxPackPath(context.repoRoot);
	if (!existsSync(sandboxPackPath)) return { selection };
	const provider = await loadSandboxProviderFromPack(sandboxPackPath);
	return { selection, profile: provider.get(selection.profile) };
}

function resolveSandboxPackPath(repoRoot: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(repoRoot, "harness", "sandbox", "sandbox.toml"),
		resolve(here, "../../../sandbox/sandbox.toml"),
		resolve(here, "../../../../sandbox/sandbox.toml"),
	];
	return candidates.find(existsSync) ?? candidates[0]!;
}

function resolvePythonLauncher(
	component: PackageToolMagnetComponent,
	context: PackageToolMagnetContext,
	descriptor: TomlTable,
	diagnostics: PackageToolMagnetDiagnostic[],
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
	context: PackageToolMagnetContext,
	component: PackageToolMagnetComponent,
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

function kebabCase(value: string): string {
	return value
		.replace(/_/g, "-")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase();
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
