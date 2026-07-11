import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as HcpMagnetProcessparsetoml } from "smol-toml";
import type { HcpServerRequest } from "../HcpServerTypes.ts";

type HcpMagnetProcesstomltable = Readonly<Record<string, unknown>>;

type HcpMagnetProcesssandboxprofile = {
	kind: "sandbox" | string;
	name: string;
	description: string;
	fs_read: string[];
	fs_write: string[];
	network: string;
	network_allowlist: string[];
	max_memory_mb: number;
	max_wall_seconds: number;
	env_allowlist: string[];
	backend: string;
};

type HcpMagnetProcessexecinput = {
	command: string;
	args?: string[];
	stdin?: string;
	cwd?: string;
	workspace_root?: string;
	sandbox?: { profile?: HcpMagnetProcesssandboxprofile } | HcpMagnetProcesssandboxprofile | null;
	tool?: HcpMagnetProcesstoolmetadata | null;
	allow_direct_exec?: boolean;
	env_overrides?: Record<string, string>;
	max_output_bytes?: number;
};

type HcpMagnetProcessexecoutput = {
	stdout: string;
	stderr: string;
	status: number | null;
	policy: unknown;
	truncated: { stdout: boolean; stderr: boolean };
};

type HcpMagnetProcesstoolmetadata = {
	name?: string;
	operation?: string;
	read_only?: boolean;
	destructive?: boolean;
	tags?: string[];
};

export type HcpMagnetProcessManifest = {
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
};

export type HcpMagnetJsonlRequest = {
	id: string;
	method: "discover" | "describe" | "call" | "open" | "close" | "cancel" | "subscribe" | "resume";
	target?: string;
	op?: string;
	input?: unknown;
	context?: Record<string, unknown>;
};

export type HcpMagnetJsonlResponse = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: unknown;
};

export type HcpMagnetProcessOptions = {
	manifest: HcpMagnetProcessManifest;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
	runtimeExec: (input: HcpMagnetProcessexecinput, signal?: AbortSignal) => Promise<HcpMagnetProcessexecoutput>;
};

function HcpMagnetProcessasstring(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function HcpMagnetProcessasnumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function HcpMagnetProcessasstringarray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function HcpMagnetProcessmanifestfromtoml(table: HcpMagnetProcesstomltable): HcpMagnetProcessManifest {
	const name = HcpMagnetProcessasstring(table.name);
	const description = HcpMagnetProcessasstring(table.description);
	const command = HcpMagnetProcessasstring(table.command);
	if (!name || !description || !command) {
		throw new Error("HCP process manifest requires name, description, and command");
	}
	return {
		kind: HcpMagnetProcessasstring(table.kind) ?? "hcp-process",
		name,
		description,
		command,
		args: HcpMagnetProcessasstringarray(table.args),
		cwd: HcpMagnetProcessasstring(table.cwd),
		env_allowlist: HcpMagnetProcessasstringarray(table.env_allowlist),
		sandbox_backend: HcpMagnetProcessasstring(table.sandbox_backend),
		max_wall_seconds: HcpMagnetProcessasnumber(table.max_wall_seconds),
		capabilities: HcpMagnetProcessasstringarray(table.capabilities),
	};
}

export async function HcpMagnetProcessmanifestload(path: string): Promise<HcpMagnetProcessManifest> {
	return HcpMagnetProcessmanifestfromtoml(HcpMagnetProcessparsetoml(await readFile(path, "utf-8")));
}

function HcpMagnetProcessrequestid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function HcpMagnetProcessmethodforop(op: string): HcpMagnetJsonlRequest["method"] {
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

function HcpMagnetProcesserrormessage(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const message = "message" in error ? error.message : undefined;
	return typeof message === "string" ? message : JSON.stringify(error);
}

function HcpMagnetProcessdefaultenvallowlist(): string[] {
	return ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
}

function HcpMagnetProcessresolvecwd(workspaceRoot: string, cwd: string | undefined): string {
	if (!cwd) return workspaceRoot;
	return isAbsolute(cwd) ? cwd : resolve(workspaceRoot, cwd);
}

function HcpMagnetProcessenvallowlist(manifest: HcpMagnetProcessManifest): string[] {
	return manifest.env_allowlist?.length ? manifest.env_allowlist : HcpMagnetProcessdefaultenvallowlist();
}

function HcpMagnetProcessenvoverrides(
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

function HcpMagnetProcessruntimesandboxprofile(manifest: HcpMagnetProcessManifest): HcpMagnetProcesssandboxprofile {
	const allowlist = HcpMagnetProcessenvallowlist(manifest);
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

function HcpMagnetProcessruntimetoolmetadata(manifest: HcpMagnetProcessManifest): HcpMagnetProcesstoolmetadata {
	return {
		name: manifest.name,
		operation: "execute",
		read_only: false,
		destructive: false,
		tags: ["hcp-process"],
	};
}

function HcpMagnetProcessparsejsonlresponse(
	manifest: HcpMagnetProcessManifest,
	request: HcpMagnetJsonlRequest,
	output: HcpMagnetProcessexecoutput,
): unknown {
	if (output.status !== 0 && output.status !== null) {
		throw new Error(`HCP process ${manifest.name} exited with status ${output.status}\n${output.stderr}`);
	}
	const line = output.stdout.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
	if (!line) {
		throw new Error(`HCP process ${manifest.name} exited without a response\n${output.stderr}`);
	}
	let response: HcpMagnetJsonlResponse;
	try {
		response = JSON.parse(line) as HcpMagnetJsonlResponse;
	} catch (error) {
		throw new Error(`HCP process ${manifest.name} returned invalid JSONL: ${HcpMagnetProcesserrormessage(error)}`);
	}
	if (response.id !== request.id) {
		throw new Error(`HCP response id mismatch: expected ${request.id}, got ${response.id}`);
	}
	if (!response.ok) {
		throw new Error(HcpMagnetProcesserrormessage(response.error));
	}
	return response.result;
}

/**
 * Transport product for external processes that speak Magenta HCP over JSONL stdio.
 *
 * This is a management/process boundary, not an AgentTool by default. A specific
 * HCP process can still expose tools through its own HCP targets. Process
 * launch is still routed through runtime://process so external Harness modules
 * share cwd, env allowlist, timeout, and direct-exec guardrails.
 */
export class HcpMagnetProcess {
	readonly kind = "hcp-process";
	readonly manifest: HcpMagnetProcessManifest;
	private readonly workspaceRoot: string;
	private readonly cwd: string;
	private readonly env?: NodeJS.ProcessEnv;
	private readonly maxOutputBytes?: number;
	private readonly runtimeExec: (
		input: HcpMagnetProcessexecinput,
		signal?: AbortSignal,
	) => Promise<HcpMagnetProcessexecoutput>;

	constructor(options: HcpMagnetProcessOptions) {
		this.manifest = options.manifest;
		this.workspaceRoot = resolve(options.cwd);
		this.cwd = HcpMagnetProcessresolvecwd(this.workspaceRoot, options.manifest.cwd);
		this.env = options.env;
		this.maxOutputBytes = options.maxOutputBytes;
		this.runtimeExec = options.runtimeExec;
	}

	health(): Record<string, unknown> {
		return {
			status: "ok",
			target: `hcp-process://${this.manifest.name}`,
			implementation: this.kind,
			command: this.manifest.command,
			args: this.manifest.args ?? [],
			transport: "hcp-jsonl",
			lifecycle: "per-call process",
			runtime: "runtime://process",
			envAllowlist: HcpMagnetProcessenvallowlist(this.manifest),
			maxWallSeconds: this.manifest.max_wall_seconds ?? 0,
		};
	}

	async call(call: HcpServerRequest): Promise<unknown> {
		switch (call.op) {
			case "proxy":
				return this.send(
					(call.input as { request?: HcpMagnetJsonlRequest } | undefined)?.request ?? {
						id: HcpMagnetProcessrequestid(),
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
					id: HcpMagnetProcessrequestid(),
					method: HcpMagnetProcessmethodforop(call.op),
					target: call.target,
					op: call.op === "call" ? "call" : undefined,
					input: call.input,
					context: call.context,
				});
			default:
				throw new Error(`HCP process ${this.manifest.name}: unsupported op "${call.op}"`);
		}
	}

	async send(request: HcpMagnetJsonlRequest): Promise<unknown> {
		const allowlist = HcpMagnetProcessenvallowlist(this.manifest);
		const output = await this.runtimeExec({
			command: this.manifest.command,
			args: this.manifest.args ?? [],
			stdin: `${JSON.stringify(request)}\n`,
			cwd: this.cwd,
			workspace_root: this.workspaceRoot,
			sandbox: { profile: HcpMagnetProcessruntimesandboxprofile(this.manifest) },
			tool: HcpMagnetProcessruntimetoolmetadata(this.manifest),
			allow_direct_exec: false,
			env_overrides: HcpMagnetProcessenvoverrides(this.env, allowlist),
			max_output_bytes: this.maxOutputBytes,
		});
		return HcpMagnetProcessparsejsonlresponse(this.manifest, request, output);
	}
}
