import { dirname, resolve } from "node:path";
import type { TSchema } from "typebox";
import { ProcessToolMagnet, type ProcessToolSpec } from "./process.ts";

export interface PythonLauncher {
	command: string;
	argsPrefix?: string[];
}

export type PythonLauncherResolver = PythonLauncher | ((params: Record<string, unknown>) => PythonLauncher);

export interface PythonModuleToolSpec<TParameters extends TSchema = TSchema>
	extends Omit<ProcessToolSpec<TParameters>, "buildInvocation"> {
	module: string;
	modulePath?: string;
	packageDir: string;
	descriptorPath: string;
	pythonBin?: string;
	pythonLauncher?: PythonLauncherResolver;
	workspaceRoot?: string;
	timeoutMs?: number;
}

export class PythonModuleToolMagnet<TParameters extends TSchema = TSchema> extends ProcessToolMagnet<TParameters> {
	constructor(spec: PythonModuleToolSpec<TParameters>) {
		super(
			{
				name: spec.name,
				label: spec.label,
				description: spec.description,
				parameters: spec.parameters,
				toolMetadata: spec.toolMetadata,
				sandbox: spec.sandbox,
				runtimeExec: spec.runtimeExec,
				maxOutputBytes: spec.maxOutputBytes,
				buildInvocation: (params) => {
					const input = isRecord(params) ? params : {};
					const specLauncher =
						typeof spec.pythonLauncher === "function" ? spec.pythonLauncher(input) : spec.pythonLauncher;
					const launcher = pythonLauncherFromInput(input) ?? specLauncher ?? {
						command: spec.pythonBin ?? "python3",
					};
					const moduleRoot = spec.modulePath ? resolve(spec.packageDir, spec.modulePath) : undefined;
					return {
						command: launcher.command,
						args: [...(launcher.argsPrefix ?? []), "-m", spec.module, ...pythonArgvFromParams(input)],
						cwd: spec.workspaceRoot ?? dirname(spec.descriptorPath),
						workspaceRoot: spec.workspaceRoot,
						env: moduleRoot ? { PYTHONPATH: prependPath(process.env.PYTHONPATH, moduleRoot) } : undefined,
						timeoutMs: spec.timeoutMs,
					};
				},
			},
			"python",
		);
	}
}

function pythonLauncherFromInput(params: Record<string, unknown>): PythonLauncher | undefined {
	const pythonBin = asString(params.pythonBin);
	return pythonBin ? { command: pythonBin } : undefined;
}

function pythonArgvFromParams(params: Record<string, unknown>): string[] {
	const argv: string[] = [];
	const subcommand = asString(params.subcommand);
	if (subcommand) argv.push(subcommand);

	const rawArgs = params.args;
	if (Array.isArray(rawArgs)) {
		argv.push(...rawArgs.map(String));
	} else if (isRecord(rawArgs)) {
		argv.push(...flagsFromRecord(rawArgs));
	}

	for (const [key, value] of Object.entries(params)) {
		if (
			key === "subcommand" ||
			key === "args" ||
			key === "pythonBin" ||
			key === "modality" ||
			value === undefined ||
			value === null
		) {
			continue;
		}
		argv.push(...flagFromValue(key, value));
	}
	return argv;
}

function flagsFromRecord(record: Record<string, unknown>): string[] {
	const argv: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined || value === null) continue;
		argv.push(...flagFromValue(key, value));
	}
	return argv;
}

function flagFromValue(key: string, value: unknown): string[] {
	const flag = `--${kebabCase(key)}`;
	if (typeof value === "boolean") return value ? [flag] : [];
	if (Array.isArray(value)) return value.flatMap((item) => [flag, String(item)]);
	return [flag, String(value)];
}

function kebabCase(value: string): string {
	return value
		.replace(/_/g, "-")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase();
}

function prependPath(current: string | undefined, next: string): string {
	return current ? `${next}:${current}` : next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
