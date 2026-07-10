import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
	/** Combined mtime+size fingerprint of the command and file-path args. */
	binaryFingerprint?: string;
	/** Hash of the explicitly-set env entries. */
	envHash: string;
	/** When this entry was written. */
	cachedAt: number;
	/** The cached tool schema list. */
	tools: McpToolSchema[];
};

/**
 * Stable identity of the server program on disk (combined mtime + size of the
 * command and any file-path arguments), or `undefined` when nothing resolves to
 * a real file (e.g. a bare PATH lookup like `aose-bio-mcp` with no file args).
 *
 * This must cover two invocation shapes:
 *  - a direct binary command (`aose-bio-mcp`): identity comes from the command.
 *  - an interpreter + script (`node server.js`, `python server.py`): the
 *    interpreter's mtime is stable across rebuilds, so the script — which lives
 *    in the args — is what actually changes. We therefore fold the identity of
 *    every argument that resolves to an existing file into the fingerprint.
 *
 * When identity cannot be determined the cache degrades to a command+args+env
 * key, which is still safe: a PATH binary swap is rare and a manual `/harness`
 * reload clears stale entries.
 */
async function binaryIdentity(command: string, args: string[], cwd: string): Promise<{ fingerprint?: string }> {
	const parts: string[] = [];
	for (const candidate of [command, ...args]) {
		const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
		try {
			const info = await stat(path);
			if (info.isFile()) parts.push(`${path}:${info.mtimeMs}:${info.size}`);
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

	let entry: McpToolsCacheEntry;
	try {
		entry = JSON.parse(await readFile(filePath, "utf-8")) as McpToolsCacheEntry;
	} catch {
		return undefined;
	}

	if (entry.formatVersion !== CACHE_FORMAT_VERSION) return undefined;
	if (entry.cwd !== cwd) return undefined;
	if (entry.command !== options.client.command) return undefined;
	if (entry.args.join("\u0000") !== args.join("\u0000")) return undefined;
	if (entry.envHash !== hashEnv(env)) return undefined;

	const identity = await binaryIdentity(options.client.command, args, cwd);
	// Only enforce identity when we could read it both at write and read time.
	if (identity.fingerprint !== undefined && entry.binaryFingerprint !== undefined) {
		if (identity.fingerprint !== entry.binaryFingerprint) return undefined;
	}

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
	const identity = await binaryIdentity(options.client.command, args, cwd);
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
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");
	} catch {
		// Best-effort cache; ignore write errors.
	}
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
