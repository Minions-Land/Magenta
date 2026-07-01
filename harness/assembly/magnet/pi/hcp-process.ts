import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { HarnessCatalogEntry, HarnessComponentCatalog } from "../../../catalog/pi/catalog.ts";
import type { HcpCall } from "../../hcp/pi/hcp.ts";
import { parseToml, type TomlTable } from "../../registry/pi/registry.ts";
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

/**
 * Magnet for external processes that speak Magenta HCP over JSONL stdio.
 *
 * This is a management/process boundary, not an AgentTool by default. A specific
 * HCP process can still expose tools through its own HCP targets.
 */
export class HcpProcessMagnet extends UniversalMagnet {
	private readonly manifest: HcpProcessManifest;
	private readonly cwd: string;
	private readonly env?: NodeJS.ProcessEnv;

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
		this.cwd = options.manifest.cwd ?? options.cwd;
		this.env = options.env;
	}

	override health(): Record<string, unknown> {
		return {
			...super.health(),
			command: this.manifest.command,
			args: this.manifest.args ?? [],
			transport: "hcp-jsonl",
			lifecycle: "per-call process",
		};
	}

	protected override async handleHcpCall(call: HcpCall): Promise<unknown> {
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
				return super.handleHcpCall(call);
		}
	}

	async send(request: HcpJsonlRequest): Promise<unknown> {
		this.assertEnabled();
		return new Promise((resolve, reject) => {
			const child = spawn(this.manifest.command, this.manifest.args ?? [], {
				cwd: this.cwd,
				env: { ...process.env, ...(this.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stderr: Buffer[] = [];
			const rl = createInterface({ input: child.stdout });
			let settled = false;

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				rl.close();
				child.kill();
				fn();
			};

			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.on("error", (error) => settle(() => reject(error)));
			child.on("close", (status) => {
				if (!settled) {
					reject(
						new Error(
							`HCP process ${this.manifest.name} exited before response with status ${status}\n${Buffer.concat(stderr).toString("utf-8")}`,
						),
					);
				}
			});
			rl.on("line", (line) => {
				if (!line.trim()) return;
				let response: HcpJsonlResponse;
				try {
					response = JSON.parse(line) as HcpJsonlResponse;
				} catch (error) {
					settle(() => reject(error));
					return;
				}
				if (response.id !== request.id) {
					settle(() => reject(new Error(`HCP response id mismatch: expected ${request.id}, got ${response.id}`)));
					return;
				}
				if (!response.ok) {
					settle(() => reject(new Error(errorMessage(response.error))));
					return;
				}
				settle(() => resolve(response.result));
			});
			child.stdin.end(`${JSON.stringify(request)}\n`);
		});
	}
}
