import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize, resolve } from "node:path";
import type { HcpRequest, HcpServer, HcpServerDescription } from "../../hcp/hcp/hcp.ts";
import type {
	ProcessExecInput,
	ProcessExecOutput,
	ProcessRuntimeProviderContract,
	ProcessRuntimeToolMetadata,
	RuntimePolicyReport,
	RuntimePolicyStatus,
} from "../contract.ts";

export type {
	ProcessExecInput,
	ProcessExecOutput,
	ProcessRuntimeToolMetadata,
	RuntimePolicyReport,
	RuntimePolicyStatus,
} from "../contract.ts";

interface RuntimePolicy {
	workspaceRoot: string;
	processCwd: string;
	fsRead: string[];
	fsWrite: string[];
	network: string;
	networkAllowlist: string[];
	envAllowlist: string[];
	maxWallSeconds: number;
	maxMemoryMb: number;
	backend: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const NETWORK_TAGS = new Set(["network", "api", "http", "fetch"]);
const NETWORK_KEYS = new Set(["url", "uri", "endpoint", "base_url", "host", "hostname", "domain"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultEnvAllowlist(): string[] {
	return ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
}

function sandboxProfile(input: ProcessExecInput): Record<string, unknown> | undefined {
	const sandbox = input.sandbox;
	if (!sandbox || !isRecord(sandbox)) return undefined;
	const wrapped = sandbox.profile;
	return isRecord(wrapped) ? wrapped : sandbox;
}

async function normalizeExistingOrLogicalPath(path: string, base: string): Promise<string> {
	const joined = isAbsolute(path) ? path : resolve(base, path);
	try {
		return await realpath(joined);
	} catch {
		return normalize(joined);
	}
}

function rejectParentTraversal(path: string): void {
	if (path.split(/[\\/]+/).includes("..")) {
		throw new Error(`path contains parent traversal: ${path}`);
	}
}

async function normalizeAccessPath(path: string, workspaceRoot: string): Promise<string> {
	rejectParentTraversal(path);
	return normalizeExistingOrLogicalPath(path, workspaceRoot);
}

async function normalizeWorkspaceRoot(path: string | undefined): Promise<string> {
	return normalizeExistingOrLogicalPath(path ?? ".", ".");
}

async function normalizeProcessCwd(path: string | undefined, workspaceRoot: string): Promise<string> {
	const normalized = await normalizeAccessPath(path ?? workspaceRoot, workspaceRoot);
	if (!isWithinOrEqual(normalized, workspaceRoot)) {
		throw new Error(`cwd must stay inside workspace: ${normalized}`);
	}
	return normalized;
}

function isWithinOrEqual(path: string, root: string): boolean {
	const normalizedRoot = normalize(root);
	const normalizedPath = normalize(path);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function parsePathRules(value: unknown, workspaceRoot: string): Promise<string[]> {
	return Promise.all(asStringArray(value).map((path) => normalizeAccessPath(path, workspaceRoot)));
}

async function policyFromInput(input: ProcessExecInput): Promise<RuntimePolicy> {
	const workspaceRoot = await normalizeWorkspaceRoot(input.workspace_root);
	const processCwd = await normalizeProcessCwd(input.cwd, workspaceRoot);
	const profile = sandboxProfile(input);
	const maxWallSecondsOverride =
		typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms) && input.timeout_ms > 0
			? Math.max(input.timeout_ms / 1000, 0.001)
			: undefined;
	if (!profile) {
		return {
			workspaceRoot,
			processCwd,
			fsRead: [workspaceRoot],
			fsWrite: [resolve(workspaceRoot, ".magenta/tmp")],
			network: "deny",
			networkAllowlist: [],
			envAllowlist: defaultEnvAllowlist(),
			maxWallSeconds: maxWallSecondsOverride ?? 0,
			maxMemoryMb: 0,
			backend: "none",
		};
	}
	const envAllowlist = asStringArray(profile.env_allowlist);
	return {
		workspaceRoot,
		processCwd,
		fsRead: await parsePathRules(profile.fs_read, workspaceRoot),
		fsWrite: await parsePathRules(profile.fs_write, workspaceRoot),
		network: typeof profile.network === "string" ? profile.network : "deny",
		networkAllowlist: asStringArray(profile.network_allowlist).map(normalizeNetworkAllowlistEntry).filter(Boolean),
		envAllowlist: envAllowlist.length > 0 ? envAllowlist : defaultEnvAllowlist(),
		maxWallSeconds: maxWallSecondsOverride ?? asNumber(profile.max_wall_seconds) ?? 0,
		maxMemoryMb: asNumber(profile.max_memory_mb) ?? 0,
		backend: typeof profile.backend === "string" ? profile.backend : "auto",
	};
}

function toolTags(tool: ProcessRuntimeToolMetadata | null | undefined): string[] {
	return asStringArray(tool?.tags);
}

function hasNetworkTag(tool: ProcessRuntimeToolMetadata | null | undefined): boolean {
	return toolTags(tool).some((tag) => NETWORK_TAGS.has(tag));
}

function fsPathsFromToolInput(input: unknown): string[] {
	if (!isRecord(input)) return [];
	const paths: string[] = [];
	for (const key of ["file_path", "path"]) {
		const value = input[key];
		if (typeof value === "string") paths.push(value);
	}
	return paths;
}

function collectNetworkTargets(value: unknown, targets: string[]): void {
	if (isRecord(value)) {
		for (const [key, nested] of Object.entries(value)) {
			if (NETWORK_KEYS.has(key)) {
				if (typeof nested === "string") {
					targets.push(nested);
				} else if (Array.isArray(nested)) {
					targets.push(...nested.filter((item): item is string => typeof item === "string"));
				}
			}
			collectNetworkTargets(nested, targets);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const nested of value) collectNetworkTargets(nested, targets);
	}
}

function networkTargetsFromInput(stdinJson: unknown, tool: ProcessRuntimeToolMetadata | null | undefined): string[] {
	const targets: string[] = [];
	collectNetworkTargets(stdinJson, targets);
	collectNetworkTargets(tool?.network, targets);
	collectNetworkTargets(tool?.network_targets, targets);
	return [...new Set(targets)].sort();
}

function hostFromUrlLike(value: string): string | undefined {
	const parts = value.split("://");
	if (parts.length < 2) return undefined;
	const authority = (parts[1] ?? "").split("/")[0] ?? "";
	const hostPort = authority.split("@").pop() ?? authority;
	return stripPort(hostPort);
}

function stripPort(value: string): string {
	if (value.startsWith("[")) return value;
	const split = value.split(":");
	return split.length > 1 ? split.slice(0, -1).join(":") : value;
}

function normalizeNetworkAllowlistEntry(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "").toLowerCase();
	return hostFromUrlLike(trimmed) ?? stripPort(trimmed);
}

function hostMatchesAllowlist(host: string, allowed: string): boolean {
	const normalizedHost = host.replace(/\.$/, "").toLowerCase();
	const normalizedAllowed = allowed.replace(/\.$/, "").toLowerCase();
	if (normalizedAllowed === "*" || normalizedHost === normalizedAllowed) return true;
	const suffix = normalizedAllowed.startsWith("*.") ? normalizedAllowed.slice(2) : undefined;
	return !!suffix && normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`);
}

function ensureNetworkAllowed(policy: RuntimePolicy, target: string): void {
	const host = normalizeNetworkAllowlistEntry(target);
	if (host && policy.networkAllowlist.some((allowed) => hostMatchesAllowlist(host, allowed))) return;
	throw new Error(`network allowlist denied host ${host}`);
}

async function ensurePathAllowed(path: string, allowed: string[], workspaceRoot: string, mode: string): Promise<void> {
	const normalized = await normalizeAccessPath(path, workspaceRoot);
	if (allowed.some((prefix) => isWithinOrEqual(normalized, prefix))) return;
	throw new Error(`sandbox denied ${mode} access to ${normalized}`);
}

async function validatePolicy(policy: RuntimePolicy, input: ProcessExecInput): Promise<void> {
	const tool = input.tool;
	if (!tool && !input.allow_direct_exec) {
		throw new Error("runtime://process direct exec requires tool metadata or allow_direct_exec=true");
	}
	const networkTagged = hasNetworkTag(tool);
	if (policy.network === "deny" && networkTagged) {
		throw new Error("network-tagged tool cannot run with network=deny");
	}
	if (policy.network === "allowlist") {
		if (policy.networkAllowlist.length === 0 && networkTagged) {
			throw new Error("network=allowlist requires network_allowlist entries for network-tagged tools");
		}
		for (const target of networkTargetsFromInput(input.stdin_json, tool)) {
			ensureNetworkAllowed(policy, target);
		}
	}
	const operation = tool?.operation ?? "";
	const paths = fsPathsFromToolInput(input.stdin_json);
	if (operation === "read") {
		for (const path of paths) await ensurePathAllowed(path, policy.fsRead, policy.workspaceRoot, "read");
	}
	if (operation === "write" || operation === "edit") {
		for (const path of paths) await ensurePathAllowed(path, policy.fsWrite, policy.workspaceRoot, "write");
	}
}

function reportPolicy(policy: RuntimePolicy): RuntimePolicyReport {
	return {
		workspace_root: policy.workspaceRoot,
		process_cwd: policy.processCwd,
		fs_read: policy.fsRead,
		fs_write: policy.fsWrite,
		network: policy.network,
		network_allowlist: policy.networkAllowlist,
		max_wall_seconds: policy.maxWallSeconds,
		max_memory_mb: policy.maxMemoryMb,
		backend: policy.backend,
		resolved_backend: "none",
		os_enforced: false,
		backend_reason:
			policy.backend === "none"
				? "portable-only backend requested"
				: "TS runtime currently enforces portable guards only; OS sandbox backend is not ported",
	};
}

function appendLimited(current: Buffer[], chunk: Buffer, limit: number): { truncated: boolean } {
	const existingBytes = current.reduce((sum, item) => sum + item.byteLength, 0);
	if (existingBytes >= limit) return { truncated: true };
	const remaining = limit - existingBytes;
	current.push(chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining));
	return { truncated: chunk.byteLength > remaining };
}

function redactedEnv(allowlist: string[], overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of allowlist) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(overrides ?? {})) {
		env[key] = value;
	}
	return env;
}

export function runtimePolicyStatus(): RuntimePolicyStatus {
	return {
		portable_guards: [
			"direct-exec gate",
			"workspace cwd",
			"environment allowlist",
			"wall-clock timeout",
			"filesystem read/write checks for declared paths",
			"network deny tag checks",
			"network allowlist checks for declared URL/host inputs",
		],
		os_backends: {
			auto_enabled: false,
			auto_candidate: null,
			sandbox_exec_available: false,
			bwrap_available: false,
		},
		production_audit: {
			os_egress_allowlist: false,
			note: "Portable guards are enforced in TypeScript; OS-level sandbox backends remain a separate migration.",
		},
	};
}

export async function execProcess(input: ProcessExecInput, signal?: AbortSignal): Promise<ProcessExecOutput> {
	if (!input.command) {
		throw new Error("runtime://process exec requires command");
	}
	const policy = await policyFromInput(input);
	await validatePolicy(policy, input);
	const policyReport = reportPolicy(policy);
	const maxBytes = input.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;

	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawn(input.command, input.args ?? [], {
			cwd: policy.processCwd,
			env: redactedEnv(policy.envAllowlist, input.env_overrides),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		const timeout =
			policy.maxWallSeconds > 0
				? setTimeout(() => {
						if (settled) return;
						child.kill();
						settled = true;
						reject(new Error(`process exceeded sandbox wall time of ${policy.maxWallSeconds}s`));
					}, policy.maxWallSeconds * 1000)
				: undefined;

		const onAbort = () => {
			if (settled) return;
			child.kill();
			settled = true;
			if (timeout) clearTimeout(timeout);
			reject(new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutTruncated ||= appendLimited(stdout, chunk, maxBytes).truncated;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrTruncated ||= appendLimited(stderr, chunk, maxBytes).truncated;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (status) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				stdout: Buffer.concat(stdout).toString("utf-8"),
				stderr: Buffer.concat(stderr).toString("utf-8"),
				status,
				policy: policyReport,
				truncated: {
					stdout: stdoutTruncated,
					stderr: stderrTruncated,
				},
			});
		});

		child.stdin.end(input.stdin ?? JSON.stringify(input.stdin_json ?? {}));
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

export class ProcessRuntimeProvider implements ProcessRuntimeProviderContract {
	describe(): HcpServerDescription {
		return {
			target: "runtime://process",
			kind: "runtime",
			ops: ["discover", "describe", "exec", "call", "policy", "status"],
			description: "Spawn a local process with Magenta portable sandbox guardrails.",
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
				osEnforcement: false,
			},
		};
	}

	discover(): Record<string, unknown> {
		return {
			provider: "process-runtime",
			targets: ["runtime://process"],
			operations: ["exec", "policy"],
		};
	}

	exec(input: ProcessExecInput, signal?: AbortSignal): Promise<ProcessExecOutput> {
		return execProcess(input, signal);
	}

	policyStatus(): RuntimePolicyStatus {
		return runtimePolicyStatus();
	}

	async health(): Promise<Record<string, unknown>> {
		return {
			status: "ok",
			target: "runtime://process",
			implementation: "native-ts",
			policy: this.policyStatus(),
			node: await commandExists(process.execPath),
		};
	}

	toHcpServer(): HcpServer {
		return {
			describe: () => this.describe(),
			call: async (call: HcpRequest): Promise<unknown> => {
				switch (call.op || "exec") {
					case "discover":
						return this.discover();
					case "describe":
						return this.describe();
					case "policy":
					case "status":
						return this.policyStatus();
					case "health":
						return this.health();
					case "exec":
					case "call":
						return this.exec(call.input as ProcessExecInput);
					default:
						throw new Error(`unsupported runtime operation ${call.op}`);
				}
			},
		};
	}
}
