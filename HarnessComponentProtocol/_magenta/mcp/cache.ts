import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { type OwnedPathSnapshot, removeOwnedPathIfUnchanged, snapshotOwnedPath } from "../owned-path.ts";
import { secureAtomicWriteFile, secureReadFile } from "../utils/secure-file.ts";
import type { McpStdioClientOptions, McpToolSchema } from "./client.ts";

/**
 * Disk cache for an MCP server's `tools/list` result.
 *
 * Enumerating a `runtime = "mcp"` server's tools requires spawning the server
 * binary, running the `initialize` handshake, and calling `tools/list` — a
 * multi-hundred-millisecond stall that today happens on every package reload
 * even though the tool set almost never changes between runs. This cache keys
 * the schema list on everything that could change it (the resolved command, its
 * arguments, the binary's identity on disk, and any explicitly-set env), so a
 * warm reload skips the spawn entirely and only pays for it again when the
 * server binary is rebuilt or its invocation changes.
 *
 * The cache stores schema only. Actual `tools/call` dispatch still goes through
 * a live {@link McpConnection}, which stays lazy: on a cache hit the binary is
 * not spawned until a tool is first invoked.
 */

/** Schema version for the on-disk format; bump to invalidate all entries. */
const CACHE_FORMAT_VERSION = 1;
export const DEFAULT_MCP_TOOLS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MCP_TOOLS_CACHE_MAX_FILES = 128;
const MAX_MCP_TOOLS_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_MCP_CACHE_DIRECTORIES = 128;
const MAINTAINED_CACHE_DIRECTORIES = new Set<string>();

function needsInitialCacheMaintenance(cacheDirectory: string): boolean {
	if (MAINTAINED_CACHE_DIRECTORIES.delete(cacheDirectory)) {
		MAINTAINED_CACHE_DIRECTORIES.add(cacheDirectory);
		return false;
	}
	MAINTAINED_CACHE_DIRECTORIES.add(cacheDirectory);
	while (MAINTAINED_CACHE_DIRECTORIES.size > MAX_TRACKED_MCP_CACHE_DIRECTORIES) {
		const oldest = MAINTAINED_CACHE_DIRECTORIES.values().next().value;
		if (typeof oldest !== "string") break;
		MAINTAINED_CACHE_DIRECTORIES.delete(oldest);
	}
	return true;
}

export type McpToolsCacheKeyInput = {
	/** Resolved command (absolute path or PATH lookup name). */
	command: string;
	args?: string[];
	/**
	 * Env entries explicitly set for the server (not the full process env). Only
	 * these participate in the key so that unrelated ambient env changes do not
	 * needlessly invalidate the cache.
	 */
	env?: Record<string, string>;
};

export type McpToolsCacheEntry = {
	formatVersion: number;
	cwd: string;
	/** The key components, stored for transparency and collision debugging. */
	command: string;
	args: string[];
	/** Combined filesystem identity fingerprint of the command and file-path args. */
	binaryFingerprint?: string;
	/** Hash of the explicitly-set env entries. */
	envHash: string;
	/** When this entry was written. */
	cachedAt: number;
	/** The cached tool schema list. */
	tools: McpToolSchema[];
};

export type McpToolsCacheCleanupOptions = {
	cacheDir: string;
	protectedPaths?: Iterable<string>;
	maxAgeMs?: number;
	maxFiles?: number;
	now?: number;
};

export type McpToolsCacheCleanupResult = {
	scannedFiles: number;
	deletedFiles: number;
	deletedBytes: number;
};

type McpCacheCandidate = {
	path: string;
	snapshot: OwnedPathSnapshot;
	entry: McpToolsCacheEntry;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCacheEntry(value: unknown): McpToolsCacheEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.formatVersion !== "number" ||
		!Number.isSafeInteger(value.formatVersion) ||
		value.formatVersion < 1 ||
		typeof value.cwd !== "string" ||
		typeof value.command !== "string" ||
		!Array.isArray(value.args) ||
		!value.args.every((argument) => typeof argument === "string") ||
		(value.binaryFingerprint !== undefined && typeof value.binaryFingerprint !== "string") ||
		typeof value.envHash !== "string" ||
		typeof value.cachedAt !== "number" ||
		!Number.isFinite(value.cachedAt) ||
		value.cachedAt < 0 ||
		!Array.isArray(value.tools)
	) {
		return undefined;
	}
	return value as McpToolsCacheEntry;
}

function isGeneratedCacheFileName(name: string): boolean {
	return /^[A-Za-z0-9_-]{0,40}-[0-9a-f]{16}\.json$/.test(name);
}

/**
 * Stable identity of the server program on disk (device, inode, ctime, mtime,
 * and size of the command and any file-path arguments), or `undefined` when
 * the executable cannot be resolved safely.
 *
 * This must cover two invocation shapes:
 *  - a direct binary command (`aose-bio-mcp`): identity comes from the command.
 *  - an interpreter + script (`node server.js`, `python server.py`): the
 *    interpreter's mtime is stable across rebuilds, so the script — which lives
 *    in the args — is what actually changes. We therefore fold the identity of
 *    every argument that resolves to an existing file into the fingerprint.
 *
 * Bare commands are resolved with the same effective PATH/PATHEXT inputs used
 * by the child process. Unresolved commands are deliberately not cacheable.
 */
function environmentValue(env: Record<string, string> | undefined, name: string): string | undefined {
	const normalizedName = name.toLowerCase();
	const explicitKey = env && Object.keys(env).find((key) => key.toLowerCase() === normalizedName);
	if (explicitKey) return env[explicitKey];
	const ambientKey = Object.keys(process.env).find((key) => key.toLowerCase() === normalizedName);
	return ambientKey ? process.env[ambientKey] : undefined;
}

function executableCandidates(command: string, cwd: string, env: Record<string, string> | undefined): string[] {
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return [isAbsolute(command) ? command : resolve(cwd, command)];
	}
	const pathValue = environmentValue(env, "PATH");
	if (!pathValue) return [];
	const extensions =
		process.platform === "win32" && extname(command) === ""
			? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
	return pathValue
		.split(delimiter)
		.flatMap((directory) => extensions.map((extension) => resolve(cwd, directory || ".", `${command}${extension}`)));
}

async function firstRegularFile(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		try {
			if ((await stat(candidate, { bigint: true })).isFile()) return candidate;
		} catch {
			// Continue through PATH entries and non-file arguments.
		}
	}
	return undefined;
}

async function binaryIdentity(
	command: string,
	args: string[],
	cwd: string,
	env: Record<string, string> | undefined,
): Promise<{ fingerprint?: string }> {
	const parts: string[] = [];
	const resolvedCommand = await firstRegularFile(executableCandidates(command, cwd, env));
	if (!resolvedCommand) return {};
	for (const path of [
		resolvedCommand,
		...args.map((candidate) => (isAbsolute(candidate) ? candidate : resolve(cwd, candidate))),
	]) {
		try {
			const info = await stat(path, { bigint: true });
			if (info.isFile()) {
				parts.push(`${path}:${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}:${info.size}`);
			}
		} catch {
			// Not a stat-able path: skip it.
		}
	}
	if (parts.length === 0) return {};
	const fingerprint = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
	return { fingerprint };
}

function hashEnv(env: Record<string, string> | undefined): string {
	if (!env) return "none";
	const sorted = Object.keys(env)
		.sort()
		.map((key) => `${key}=${env[key]}`)
		.join("\n");
	return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

/**
 * Deterministic cache file name for a server. Derived from the server name plus
 * a hash of the resolved command+args so two servers, or the same binary invoked
 * differently, never collide on one file.
 */
function cacheFileName(serverName: string, command: string, args: string[], cwd: string): string {
	const safeName = serverName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
	const digest = createHash("sha256")
		.update(`${cwd}\u0000${command}\u0000${args.join("\u0000")}`)
		.digest("hex")
		.slice(0, 16);
	return `${safeName}-${digest}.json`;
}

export type McpToolsCacheOptions = {
	/** Directory where cache files live. Created on demand. */
	cacheDir: string;
	serverName: string;
	client: Pick<McpStdioClientOptions, "command" | "args" | "env" | "cwd">;
};

/**
 * Read a cached `tools/list` result if one exists and is still valid for the
 * current binary identity + invocation. Returns `undefined` on any miss
 * (absent, unreadable, format/version mismatch, or binary changed).
 */
export async function readMcpToolsCache(options: McpToolsCacheOptions): Promise<McpToolSchema[] | undefined> {
	const args = options.client.args ?? [];
	const cwd = resolve(options.client.cwd ?? process.cwd());
	const env = normalizeEnv(options.client.env);
	const filePath = join(options.cacheDir, cacheFileName(options.serverName, options.client.command, args, cwd));
	const cacheDirectory = resolve(options.cacheDir);
	if (needsInitialCacheMaintenance(cacheDirectory)) {
		await cleanupMcpToolsCache({ cacheDir: cacheDirectory, protectedPaths: [filePath] }).catch(() => undefined);
	}

	let entry: McpToolsCacheEntry | undefined;
	try {
		entry = parseCacheEntry(
			JSON.parse(
				(await secureReadFile(filePath, { maxBytes: MAX_MCP_TOOLS_CACHE_ENTRY_BYTES })).toString("utf-8"),
			) as unknown,
		);
	} catch {
		return undefined;
	}

	if (!entry) return undefined;
	if (entry.formatVersion !== CACHE_FORMAT_VERSION) return undefined;
	// A valid key does not make a schema valid forever.  In particular, a
	// read-only process can otherwise keep serving an entry that cleanup never
	// gets a chance to inspect.  Treat clock-skewed (future) timestamps as a
	// miss as well; this fails closed and lets the next live discovery refresh
	// the schema.
	const ageMs = Date.now() - entry.cachedAt;
	if (ageMs < 0 || ageMs >= DEFAULT_MCP_TOOLS_CACHE_MAX_AGE_MS) return undefined;
	if (entry.cwd !== cwd) return undefined;
	if (entry.command !== options.client.command) return undefined;
	if (entry.args.join("\u0000") !== args.join("\u0000")) return undefined;
	if (entry.envHash !== hashEnv(env)) return undefined;

	const identity = await binaryIdentity(options.client.command, args, cwd, env);
	if (!identity.fingerprint || !entry.binaryFingerprint || identity.fingerprint !== entry.binaryFingerprint)
		return undefined;

	return Array.isArray(entry.tools) ? entry.tools : undefined;
}

/**
 * Persist a `tools/list` result for later reuse. Best-effort: write failures are
 * swallowed so a read-only or full disk never breaks package assembly.
 */
export async function writeMcpToolsCache(options: McpToolsCacheOptions, tools: McpToolSchema[]): Promise<void> {
	const args = options.client.args ?? [];
	const cwd = resolve(options.client.cwd ?? process.cwd());
	const env = normalizeEnv(options.client.env);
	const identity = await binaryIdentity(options.client.command, args, cwd, env);
	if (!identity.fingerprint) return;
	const entry: McpToolsCacheEntry = {
		formatVersion: CACHE_FORMAT_VERSION,
		cwd,
		command: options.client.command,
		args,
		binaryFingerprint: identity.fingerprint,
		envHash: hashEnv(env),
		cachedAt: Date.now(),
		tools,
	};
	const filePath = join(options.cacheDir, cacheFileName(options.serverName, options.client.command, args, cwd));
	try {
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	} catch {
		return;
	}
	const cacheDirectory = resolve(options.cacheDir);
	if (needsInitialCacheMaintenance(cacheDirectory)) {
		await cleanupMcpToolsCache({ cacheDir: cacheDirectory, protectedPaths: [filePath] }).catch(() => undefined);
	}
	try {
		await secureAtomicWriteFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, {
			mode: 0o600,
			maxBytes: MAX_MCP_TOOLS_CACHE_ENTRY_BYTES,
		});
		await cleanupMcpToolsCache({ cacheDir: cacheDirectory, protectedPaths: [filePath] }).catch(() => undefined);
	} catch {
		// Best-effort cache; ignore write errors.
	}
}

/**
 * Bound one MCP tools cache namespace. Only generated names containing a
 * structurally valid cache entry are candidates; links, hard links, temporary
 * writers, locks, unknown versions/shapes, and changed inodes are preserved.
 */
export async function cleanupMcpToolsCache(options: McpToolsCacheCleanupOptions): Promise<McpToolsCacheCleanupResult> {
	const result: McpToolsCacheCleanupResult = { scannedFiles: 0, deletedFiles: 0, deletedBytes: 0 };
	const cacheDir = resolve(options.cacheDir);
	if (!(await snapshotOwnedPath(cacheDir, "directory"))) return result;
	let entries: Dirent<string>[];
	try {
		entries = await readdir(cacheDir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return result;
	}
	const protectedPaths = new Set([...(options.protectedPaths ?? [])].map((path) => resolve(path)));
	const candidates: McpCacheCandidate[] = [];
	for (const directoryEntry of entries) {
		if (
			!directoryEntry.isFile() ||
			directoryEntry.isSymbolicLink() ||
			!isGeneratedCacheFileName(directoryEntry.name)
		) {
			continue;
		}
		result.scannedFiles++;
		const path = join(cacheDir, directoryEntry.name);
		if (
			entries.some(
				(candidate) =>
					candidate.name === `${directoryEntry.name}.lock` ||
					candidate.name.startsWith(`.${directoryEntry.name}.tmp-`),
			)
		) {
			continue;
		}
		const snapshot = await snapshotOwnedPath(path, "file");
		if (!snapshot || snapshot.size > MAX_MCP_TOOLS_CACHE_ENTRY_BYTES) continue;
		let entry: McpToolsCacheEntry | undefined;
		try {
			entry = parseCacheEntry(
				JSON.parse(
					(await secureReadFile(path, { maxBytes: MAX_MCP_TOOLS_CACHE_ENTRY_BYTES })).toString("utf8"),
				) as unknown,
			);
		} catch {
			continue;
		}
		if (!entry || entry.formatVersion !== CACHE_FORMAT_VERSION) continue;
		candidates.push({ path, snapshot, entry });
	}

	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MCP_TOOLS_CACHE_MAX_AGE_MS;
	const maxFiles = options.maxFiles ?? DEFAULT_MCP_TOOLS_CACHE_MAX_FILES;
	let retainedFiles = candidates.length;
	candidates.sort(
		(left, right) =>
			Math.max(left.entry.cachedAt, left.snapshot.mtimeMs) -
				Math.max(right.entry.cachedAt, right.snapshot.mtimeMs) || left.path.localeCompare(right.path),
	);
	for (const candidate of candidates) {
		const newestTimestamp = Math.max(candidate.entry.cachedAt, candidate.snapshot.mtimeMs);
		const expired = maxAgeMs >= 0 && now - newestTimestamp >= maxAgeMs;
		if (!expired && retainedFiles <= maxFiles) break;
		if (protectedPaths.has(candidate.path)) continue;
		if (!(await removeOwnedPathIfUnchanged(candidate.path, candidate.snapshot))) continue;
		retainedFiles--;
		result.deletedFiles++;
		result.deletedBytes += candidate.snapshot.size;
	}
	return result;
}

/**
 * Reduce a full process env down to only string-valued entries. The MCP client
 * merges `process.env` with descriptor `[env]`, but only the descriptor-declared
 * values are meaningful for the cache key; callers pass the descriptor env here.
 */
function normalizeEnv(env: NodeJS.ProcessEnv | Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
