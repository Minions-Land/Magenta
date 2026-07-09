import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HarnessCatalogEntry, HarnessComponentCatalog } from "../catalog/pi/catalog.ts";
import { parseToml, type TomlTable } from "../hcp-client/registry/registry.ts";
import type { HcpRequest } from "../hcp-client/contract/hcp-server.ts";
import {
	execProcess,
	type ProcessExecOutput,
	type ProcessRuntimeToolMetadata,
} from "../modules/runtime/magenta/process-runtime.ts";
import type { SandboxProfile } from "../modules/sandbox/contract.ts";
import { UniversalMagnet } from "./universal.ts";

export interface HcpProcessManifest {
	kind: "hcp-process" | string;
	name: string;
	description: string;
	command: string;
	args?: string[];
	cwd?: string;
	env_allowlist?: string[];
	sandbox_backend?: string;
	max_wall_seconds?: number;
	capabilities?: string[];
}

export interface HcpJsonlRequest {
	id: string;
	method: "discover" | "describe" | "call" | "open" | "close" | "cancel" | "subscribe" | "resume";
	target?: string;
	op?: string;
	input?: unknown;
	context?: Record<string, unknown>;
}

export interface HcpJsonlResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: unknown;
}

export interface HcpProcessMagnetOptions {
	manifest: HcpProcessManifest;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
	runtimeExec?: (input: Parameters<typeof execProcess>[0], signal?: AbortSignal) => Promise<ProcessExecOutput>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

export function hcpProcessManifestFromToml(table: TomlTable): HcpProcessManifest {
	const name = asString(table.name);
	const description = asString(table.description);
	const command = asString(table.command);
	if (!name || !description || !command) {
		throw new Error("HCP process manifest requires name, description, and command");
	}
	return {
		kind: asString(table.kind) ?? "hcp-process",
		name,
		description,
		command,
		args: asStringArray(table.args),
		cwd: asString(table.cwd),
		env_allowlist: asStringArray(table.env_allowlist),
		sandbox_backend: asString(table.sandbox_backend),
		max_wall_seconds: asNumber(table.max_wall_seconds),
		capabilities: asStringArray(table.capabilities),
	};
}

export async function loadHcpProcessManifest(path: string): Promise<HcpProcessManifest> {
	return hcpProcessManifestFromToml(parseToml(await readFile(path, "utf-8")));
}

export async function createHcpProcessMagnetFromCatalogEntry(
	catalog: HarnessComponentCatalog,
	entry: HarnessCatalogEntry,
	options: Omit<HcpProcessMagnetOptions, "manifest">,
): Promise<HcpProcessMagnet> {
	return new HcpProcessMagnet({
		...options,
		manifest: await loadHcpProcessManifest(resolveCatalogComponentPath(catalog, entry)),
	});
}

function requestId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function methodForOp(op: string): HcpJsonlRequest["method"] {
	switch (op) {
		case "discover":
			return "discover";
		case "describe":
			return "describe";
		case "open":
		case "close":
		case "cancel":
		case "subscribe":
		case "resume":
			return op;
		default:
			return "call";
	}
}

function errorMessage(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const message = "message" in error ? error.message : undefined;
	return typeof message === "string" ? message : JSON.stringify(error);
}

function defaultEnvAllowlist(): string[] {
	return ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
}

function resolveProcessCwd(workspaceRoot: string, cwd: string | undefined): string {
	if (!cwd) return workspaceRoot;
	return isAbsolute(cwd) ? cwd : resolve(workspaceRoot, cwd);
}

function envAllowlist(manifest: HcpProcessManifest): string[] {
	return manifest.env_allowlist?.length ? manifest.env_allowlist : defaultEnvAllowlist();
}

function envOverrides(
	env: NodeJS.ProcessEnv | undefined,
	allowlist: readonly string[],
): Record<string, string> | undefined {
	if (!env) return undefined;
	const allowed = new Set(allowlist);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (allowed.has(key) && typeof value === "string") {
			result[key] = value;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function runtimeSandboxProfile(manifest: HcpProcessManifest): SandboxProfile {
	const allowlist = envAllowlist(manifest);
	return {
		kind: "sandbox",
		name: `hcp-process-${manifest.name}`,
		description: `Runtime policy profile for HCP process ${manifest.name}.`,
		fs_read: ["."],
		fs_write: ["./.magenta/tmp", "/tmp"],
		network: "deny",
		network_allowlist: [],
		max_memory_mb: 0,
		max_wall_seconds: manifest.max_wall_seconds ?? 0,
		env_allowlist: allowlist,
		backend: manifest.sandbox_backend ?? "auto",
	};
}

function runtimeToolMetadata(manifest: HcpProcessManifest): ProcessRuntimeToolMetadata {
	return {
		name: manifest.name,
		operation: "execute",
		read_only: false,
		destructive: false,
		tags: ["hcp-process"],
	};
}

function parseJsonlResponse(
	manifest: HcpProcessManifest,
	request: HcpJsonlRequest,
	output: ProcessExecOutput,
): unknown {
	if (output.status !== 0 && output.status !== null) {
		throw new Error(`HCP process ${manifest.name} exited with status ${output.status}\n${output.stderr}`);
	}
	const line = output.stdout.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
	if (!line) {
		throw new Error(`HCP process ${manifest.name} exited without a response\n${output.stderr}`);
	}
	let response: HcpJsonlResponse;
	try {
		response = JSON.parse(line) as HcpJsonlResponse;
	} catch (error) {
		throw new Error(`HCP process ${manifest.name} returned invalid JSONL: ${errorMessage(error)}`);
	}
	if (response.id !== request.id) {
		throw new Error(`HCP response id mismatch: expected ${request.id}, got ${response.id}`);
	}
	if (!response.ok) {
		throw new Error(errorMessage(response.error));
	}
	return response.result;
}

/**
 * HcpMagnet for external processes that speak Magenta HCP over JSONL stdio.
 *
 * This is a management/process boundary, not an AgentTool by default. A specific
 * HCP process can still expose tools through its own HCP targets. Process
 * launch is still routed through runtime://process so external Harness modules
 * share cwd, env allowlist, timeout, and direct-exec guardrails.
 */
export class HcpProcessMagnet extends UniversalMagnet {
	private readonly manifest: HcpProcessManifest;
	private readonly workspaceRoot: string;
	private readonly cwd: string;
	private readonly env?: NodeJS.ProcessEnv;
	private readonly maxOutputBytes?: number;
	private readonly runtimeExec: (
		input: Parameters<typeof execProcess>[0],
		signal?: AbortSignal,
	) => Promise<ProcessExecOutput>;

	constructor(options: HcpProcessMagnetOptions) {
		super({
			descriptor: {
				target: `hcp-process://${options.manifest.name}`,
				kind: "hcp-process",
				name: options.manifest.name,
				implementation: "hcp-process",
				description: options.manifest.description,
				ops: ["describe", "configure", "enable", "disable", "health", "state", "proxy", "discover", "call"],
				metadata: {
					command: options.manifest.command,
					args: options.manifest.args ?? [],
					capabilities: options.manifest.capabilities ?? [],
					transport: "hcp-jsonl",
				},
			},
		});
		this.manifest = options.manifest;
		this.workspaceRoot = resolve(options.cwd);
		this.cwd = resolveProcessCwd(this.workspaceRoot, options.manifest.cwd);
		this.env = options.env;
		this.maxOutputBytes = options.maxOutputBytes;
		this.runtimeExec = options.runtimeExec ?? execProcess;
	}

	override health(): Record<string, unknown> {
		return {
			...super.health(),
			command: this.manifest.command,
			args: this.manifest.args ?? [],
			transport: "hcp-jsonl",
			lifecycle: "per-call process",
			runtime: "runtime://process",
			envAllowlist: envAllowlist(this.manifest),
			maxWallSeconds: this.manifest.max_wall_seconds ?? 0,
		};
	}

	protected override async handleHcpRequest(call: HcpRequest): Promise<unknown> {
		switch (call.op) {
			case "proxy":
				return this.send(
					(call.input as { request?: HcpJsonlRequest } | undefined)?.request ?? {
						id: requestId(),
						method: "discover",
						input: {},
						context: call.context,
					},
				);
			case "discover":
			case "describe":
			case "call":
			case "open":
			case "close":
			case "cancel":
			case "subscribe":
			case "resume":
				return this.send({
					id: requestId(),
					method: methodForOp(call.op),
					target: call.target,
					op: call.op === "call" ? "call" : undefined,
					input: call.input,
					context: call.context,
				});
			default:
				return super.handleHcpRequest(call);
		}
	}

	async send(request: HcpJsonlRequest): Promise<unknown> {
		this.assertEnabled();
		const allowlist = envAllowlist(this.manifest);
		const output = await this.runtimeExec({
			command: this.manifest.command,
			args: this.manifest.args ?? [],
			stdin: `${JSON.stringify(request)}\n`,
			cwd: this.cwd,
			workspace_root: this.workspaceRoot,
			sandbox: { profile: runtimeSandboxProfile(this.manifest) },
			tool: runtimeToolMetadata(this.manifest),
			allow_direct_exec: false,
			env_overrides: envOverrides(this.env, allowlist),
			max_output_bytes: this.maxOutputBytes,
		});
		return parseJsonlResponse(this.manifest, request, output);
	}
}
