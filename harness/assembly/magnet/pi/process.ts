import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import type { HarnessCatalogEntry, HarnessComponentCatalog } from "../../../catalog/pi/catalog.ts";
import type { HcpCall } from "../../hcp/pi/hcp.ts";
import { parseToml, type TomlTable } from "../../registry/pi/registry.ts";
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
	parameters?: TSchema | Record<string, unknown>;
}

export interface ProcessToolMagnetOptions {
	manifest: ProcessToolManifest;
	/** Root used to resolve manifest commands like `bins/process-tools/...`. */
	manifestRoot: string;
	/** Workspace cwd passed as the child working directory. */
	cwd: string;
	/** Optional command path override, useful when the Rust binary is built elsewhere. */
	commandOverride?: string;
	/** Extra environment values for the process. */
	env?: NodeJS.ProcessEnv;
	/** Max captured stdout/stderr bytes. Default: 10 MiB. */
	maxOutputBytes?: number;
}

export interface ProcessToolDetails {
	status: number | null;
	stderr?: string;
	target: string;
	command: string;
	args: string[];
}

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
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
	return resolve(dirname(catalog.inventoryPath), "..", path);
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
		return resolve(dirname(catalog.inventoryPath), "..");
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
): Promise<ProcessToolMagnet> {
	const manifestPath = resolveCatalogComponentPath(catalog, entry);
	const manifest = await loadProcessToolManifest(manifestPath);
	return new ProcessToolMagnet({
		...options,
		manifest,
		manifestRoot: resolveCatalogManifestRoot(catalog, entry),
	});
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
	return command.endsWith("/process-tools/target/release/magenta-process-tools");
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

function appendLimited(current: Buffer[], chunk: Buffer, limit: number): { total: number; truncated: boolean } {
	const existingBytes = current.reduce((sum, item) => sum + item.byteLength, 0);
	if (existingBytes >= limit) return { total: existingBytes + chunk.byteLength, truncated: true };
	const remaining = limit - existingBytes;
	current.push(chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining));
	return { total: existingBytes + chunk.byteLength, truncated: chunk.byteLength > remaining };
}

/**
 * Magnet for Magenta1-style Rust process tools.
 *
 * Protocol: spawn `command args...`, write JSON params to stdin, read stdout as
 * the tool result. This matches `general-harness/bins/process-tools`.
 */
export class ProcessToolMagnet extends UniversalMagnet {
	private readonly options: ProcessToolMagnetOptions;
	private readonly command: string;
	private readonly args: string[];
	private readonly toolName: string;

	constructor(options: ProcessToolMagnetOptions) {
		const toolName = toToolName(options.manifest.name);
		super({
			descriptor: {
				target: `tool://${options.manifest.name}`,
				kind: "tool",
				name: options.manifest.name,
				implementation: "process",
				description: options.manifest.description,
				ops: ["describe", "configure", "enable", "disable", "health", "state", "toTool", "call"],
				metadata: {
					operation: options.manifest.operation,
					readOnly: options.manifest.read_only ?? false,
					destructive: options.manifest.destructive ?? false,
					version: options.manifest.version,
					tags: options.manifest.tags ?? [],
					capabilities: options.manifest.capabilities ?? [],
					toolName,
				},
			},
		});
		this.options = options;
		this.command = resolveCommand(options.manifestRoot, options.manifest.command, options.commandOverride);
		this.args = [...(options.manifest.args ?? [])];
		this.toolName = toolName;
	}

	override async health(): Promise<Record<string, unknown>> {
		return {
			...(await super.health()),
			command: this.command,
			args: this.args,
			commandExists: await commandExists(this.command),
		};
	}

	override toTool(): AgentTool<TSchema, ProcessToolDetails> {
		const parameters = (this.options.manifest.parameters as TSchema | undefined) ?? defaultParameters();
		return {
			name: this.toolName,
			label: this.options.manifest.name,
			description: this.options.manifest.description,
			parameters,
			execute: async (_toolCallId, params, signal) => this.executeProcess(params, signal),
		};
	}

	protected override async handleHcpCall(call: HcpCall): Promise<unknown> {
		switch (call.op) {
			case "call":
			case "run":
			case "execute":
				return this.executeProcess(call.input, undefined);
			default:
				return super.handleHcpCall(call);
		}
	}

	private async executeProcess(input: unknown, signal?: AbortSignal): Promise<AgentToolResult<ProcessToolDetails>> {
		this.assertEnabled();
		await ensureCommandReady(this.command);
		return new Promise((resolvePromise, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			const child = spawn(this.command, this.args, {
				cwd: this.options.cwd,
				env: { ...process.env, ...(this.options.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const maxBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutTruncated = false;
			let stderrTruncated = false;

			const onAbort = () => {
				child.kill();
				reject(new Error("Operation aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout.on("data", (chunk: Buffer) => {
				const result = appendLimited(stdout, chunk, maxBytes);
				stdoutTruncated ||= result.truncated;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				const result = appendLimited(stderr, chunk, maxBytes);
				stderrTruncated ||= result.truncated;
			});
			child.on("error", (error) => {
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
			child.on("close", (status) => {
				signal?.removeEventListener("abort", onAbort);
				const stdoutText = Buffer.concat(stdout).toString("utf-8");
				const stderrText = Buffer.concat(stderr).toString("utf-8");
				const suffix = stdoutTruncated ? "\n[stdout truncated]" : "";
				const stderrSuffix = stderrTruncated ? "\n[stderr truncated]" : "";
				if (status !== 0) {
					reject(
						new Error(
							`process tool ${this.options.manifest.name} exited with status ${status}\n${stderrText}${stderrSuffix}`,
						),
					);
					return;
				}
				resolvePromise({
					content: [{ type: "text", text: `${stdoutText}${suffix}` }],
					details: {
						status,
						stderr: stderrText ? `${stderrText}${stderrSuffix}` : undefined,
						target: `tool://${this.options.manifest.name}`,
						command: this.command,
						args: this.args,
					},
				});
			});

			child.stdin.end(JSON.stringify(input ?? {}));
		});
	}
}
