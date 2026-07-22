import type { Dirent, Stats } from "node:fs";
import { appendFileSync, lstatSync } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Writable } from "node:stream";

/**
 * Runtime logs are diagnostic, reproducible artifacts rather than durable
 * state. Keep the defaults deliberately finite so a noisy child process cannot
 * exhaust the host volume.
 */
export const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_LOG_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 200;
export const DEFAULT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_FLUSH_BYTES = 64 * 1024;
export const DEFAULT_LOG_FLUSH_INTERVAL_MS = 100;

const TRUNCATION_MARKER = "\n[log truncated at 16 MiB; later output omitted]\n";

export type BoundedLogState = {
	bytes: number;
	truncated: boolean;
};

export function createBoundedLogState(initialBytes = 0): BoundedLogState {
	return { bytes: Math.max(0, initialBytes), truncated: false };
}

/**
 * Write output without allowing one log file to grow past the hard limit.
 * `state` is owned by the caller because each event may have a different
 * stream. Once the limit is reached, one short marker is retained and later
 * output is intentionally discarded.
 */
export function writeBoundedLog(
	stream: Pick<Writable, "write" | "writableEnded" | "destroyed">,
	state: BoundedLogState,
	data: string | Uint8Array,
	maxBytes = DEFAULT_LOG_MAX_BYTES,
): void {
	if (state.truncated || stream.writableEnded || stream.destroyed) return;
	const input = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	if (input.length === 0) return;
	if (maxBytes <= 0 || state.bytes >= maxBytes) {
		state.truncated = true;
		return;
	}

	const remaining = maxBytes - state.bytes;
	if (input.length <= remaining) {
		stream.write(input);
		state.bytes += input.length;
		return;
	}

	// Reserve room for the marker where possible. A very small test/configured
	// limit may split the marker; the hard byte cap still takes precedence.
	const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
	if (remaining <= marker.length) {
		stream.write(marker.subarray(0, remaining));
		state.bytes += remaining;
	} else {
		const payloadBytes = remaining - marker.length;
		if (payloadBytes > 0) {
			stream.write(input.subarray(0, payloadBytes));
			state.bytes += payloadBytes;
		}
		stream.write(marker);
		state.bytes += marker.length;
	}
	state.truncated = true;
}

export type BufferedLogSink = {
	writableEnded: boolean;
	destroyed: boolean;
	write(data: string | Uint8Array): boolean;
	end(): unknown;
	destroy(error?: Error): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
};

/** Batch streaming diagnostics while preserving the existing hard byte cap. */
export class BufferedBoundedLog {
	private readonly sink: BufferedLogSink;
	private readonly state: BoundedLogState;
	private readonly flushBytes: number;
	private readonly flushIntervalMs: number;
	private readonly maxBytes: number;
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private flushTimer?: NodeJS.Timeout;
	private ended = false;

	constructor(
		sink: BufferedLogSink,
		options: {
			state?: BoundedLogState;
			flushBytes?: number;
			flushIntervalMs?: number;
			maxBytes?: number;
		} = {},
	) {
		this.sink = sink;
		this.state = options.state ?? createBoundedLogState();
		this.flushBytes = BufferedBoundedLog.nonNegativeInteger(
			options.flushBytes ?? DEFAULT_LOG_FLUSH_BYTES,
			"buffered log flushBytes",
		);
		this.flushIntervalMs = BufferedBoundedLog.nonNegativeInteger(
			options.flushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS,
			"buffered log flushIntervalMs",
		);
		this.maxBytes = BufferedBoundedLog.nonNegativeInteger(
			options.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
			"buffered log maxBytes",
		);
	}

	private static nonNegativeInteger(value: number, label: string): number {
		if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
		return value;
	}

	write(data: string | Uint8Array): void {
		if (this.ended || this.state.truncated || this.sink.writableEnded || this.sink.destroyed) return;
		const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		if (chunk.length === 0) return;
		this.pending.push(chunk);
		this.pendingBytes += chunk.length;
		if (
			this.flushBytes === 0 ||
			this.flushIntervalMs === 0 ||
			this.pendingBytes >= this.flushBytes ||
			this.state.bytes + this.pendingBytes >= this.maxBytes
		) {
			this.flush();
			return;
		}
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, this.flushIntervalMs);
		this.flushTimer.unref?.();
	}

	flush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.pendingBytes === 0) return;
		const chunks = this.pending;
		const bytes = this.pendingBytes;
		this.pending = [];
		this.pendingBytes = 0;
		const output = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytes);
		try {
			writeBoundedLog(this.sink, this.state, output, this.maxBytes);
		} catch (error) {
			try {
				this.sink.destroy(error instanceof Error ? error : new Error(String(error)));
			} catch {
				// The sink is already unusable; its owner will settle the operation.
			}
		}
	}

	end(): void {
		if (this.ended) return;
		this.flush();
		this.ended = true;
		if (!this.sink.writableEnded && !this.sink.destroyed) this.sink.end();
	}

	onError(listener: (error: Error) => void): void {
		this.sink.on("error", listener);
	}
}

/**
 * Synchronous bounded append for small structured audit streams. Existing
 * symlinks and non-files are refused, and every truncating append fills the
 * remaining budget with at most one marker so later calls become no-ops.
 */
export function appendBoundedFileSync(
	filePath: string,
	data: string | Uint8Array,
	maxBytes = DEFAULT_LOG_MAX_BYTES,
): { bytesWritten: number; truncated: boolean } {
	const limit = Math.max(0, Math.floor(maxBytes));
	let existingBytes = 0;
	try {
		const info = lstatSync(filePath);
		if (!info.isFile() || info.isSymbolicLink()) return { bytesWritten: 0, truncated: true };
		existingBytes = info.size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { bytesWritten: 0, truncated: true };
	}
	if (limit === 0 || existingBytes >= limit) return { bytesWritten: 0, truncated: true };

	const input = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	if (input.length === 0) return { bytesWritten: 0, truncated: false };
	const remaining = limit - existingBytes;
	if (input.length <= remaining) {
		appendFileSync(filePath, input, { mode: 0o600 });
		return { bytesWritten: input.length, truncated: false };
	}

	const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
	const output = Buffer.allocUnsafe(remaining);
	if (remaining <= marker.length) {
		marker.copy(output, 0, 0, remaining);
	} else {
		const payloadBytes = remaining - marker.length;
		input.copy(output, 0, 0, payloadBytes);
		marker.copy(output, payloadBytes);
	}
	appendFileSync(filePath, output, { mode: 0o600 });
	return { bytesWritten: output.length, truncated: true };
}

export type LogCleanupOptions = {
	/** Root under which traversal is allowed. Symlink roots are ignored. */
	root: string;
	/** Select only reproducible log artifacts; unknown files are left alone. */
	fileFilter?: (path: string) => boolean;
	/** Exact files that may be live and must never be unlinked. */
	protectedPaths?: Iterable<string>;
	/** Directories that may contain live logs and must never be traversed for deletion. */
	protectedPrefixes?: Iterable<string>;
	/** Remove directories left empty after artifact deletion only when this filter approves them. */
	emptyDirectoryFilter?: (path: string) => boolean;
	maxAgeMs?: number;
	maxTotalBytes?: number;
	maxFiles?: number;
	now?: number;
};

export type LogCleanupResult = {
	scannedFiles: number;
	deletedFiles: number;
	deletedBytes: number;
	protectedFiles: number;
	deletedDirectories: number;
};

type Candidate = { path: string; size: number; mtimeMs: number };

function isWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function isProtected(path: string, exact: Set<string>, prefixes: string[]): boolean {
	if (exact.has(path)) return true;
	return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}${sep}`));
}

async function collectCandidates(
	root: string,
	directory: string,
	filter: (path: string) => boolean,
	output: Candidate[],
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (!isWithin(root, path) || entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await collectCandidates(root, path, filter, output);
			continue;
		}
		if (!entry.isFile() || !filter(path)) continue;
		try {
			const info = await lstat(path);
			if (info.isFile()) output.push({ path, size: info.size, mtimeMs: info.mtimeMs });
		} catch {
			// Files can disappear while a session is shutting down.
		}
	}
}

async function pruneEmptyDirectories(
	root: string,
	directory: string,
	filter: (path: string) => boolean,
	exact: Set<string>,
	prefixes: string[],
): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return 0;
	}
	let deleted = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const child = resolve(directory, entry.name);
		if (!isWithin(root, child) || isProtected(child, exact, prefixes)) continue;
		deleted += await pruneEmptyDirectories(root, child, filter, exact, prefixes);
	}
	if (directory === root || !filter(directory) || isProtected(directory, exact, prefixes)) return deleted;
	try {
		await rmdir(directory);
		return deleted + 1;
	} catch {
		return deleted;
	}
}

/**
 * Remove old/over-budget log files below one namespace. Traversal is
 * symlink-free and every candidate is checked against the resolved root, so a
 * malformed path or a symlink cannot cause deletion outside the namespace.
 */
export async function cleanupLogTree(options: LogCleanupOptions): Promise<LogCleanupResult> {
	const root = resolve(options.root);
	let rootInfo: Stats;
	try {
		rootInfo = await lstat(root);
	} catch {
		return { scannedFiles: 0, deletedFiles: 0, deletedBytes: 0, protectedFiles: 0, deletedDirectories: 0 };
	}
	if (!rootInfo.isDirectory()) {
		return { scannedFiles: 0, deletedFiles: 0, deletedBytes: 0, protectedFiles: 0, deletedDirectories: 0 };
	}

	const exact = new Set([...(options.protectedPaths ?? [])].map((path) => resolve(path)));
	const prefixes = [...(options.protectedPrefixes ?? [])].map((path) => resolve(path));
	const filter = options.fileFilter ?? (() => true);
	const candidates: Candidate[] = [];
	await collectCandidates(root, root, filter, candidates);

	const maxAgeMs = options.maxAgeMs ?? DEFAULT_LOG_MAX_AGE_MS;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LOG_MAX_TOTAL_BYTES;
	const maxFiles = options.maxFiles ?? DEFAULT_LOG_MAX_FILES;
	const now = options.now ?? Date.now();
	let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
	let fileCount = candidates.length;
	let deletedBytes = 0;
	let deletedFiles = 0;
	let protectedFiles = 0;

	candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
	for (const candidate of candidates) {
		const expired = maxAgeMs >= 0 && now - candidate.mtimeMs >= maxAgeMs;
		const overBudget = totalBytes > maxTotalBytes || fileCount > maxFiles;
		if (!expired && !overBudget) break;
		if (isProtected(candidate.path, exact, prefixes)) {
			protectedFiles++;
			continue;
		}
		try {
			await unlink(candidate.path);
			totalBytes -= candidate.size;
			fileCount--;
			deletedBytes += candidate.size;
			deletedFiles++;
		} catch {
			// A concurrently closed session may have removed the file already.
		}
	}

	const deletedDirectories = options.emptyDirectoryFilter
		? await pruneEmptyDirectories(root, root, options.emptyDirectoryFilter, exact, prefixes)
		: 0;
	return { scannedFiles: candidates.length, deletedFiles, deletedBytes, protectedFiles, deletedDirectories };
}

export { TRUNCATION_MARKER as LOG_TRUNCATION_MARKER };
