import { randomUUID } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";

const DEFAULT_PRIVATE_FILE_MODE = 0o600;
const DEFAULT_PRIVATE_DIRECTORY_MODE = 0o700;

export type SecureFileOptions = {
	mode?: number;
	/** Preserve the historical behavior that a read-only target cannot be replaced via its writable parent. */
	requireOwnerWritable?: boolean;
	/** Hard-linked state can be mutated through an unobserved path, so reject it by default. */
	requireSingleLink?: boolean;
};

export type SecureReadFileOptions = SecureFileOptions & {
	/** Refuse to retain more than this many bytes, including if the file grows while open. */
	maxBytes: number;
};

export type SecureWriteFileOptions = SecureFileOptions & {
	/** Refuse to publish content larger than this many bytes. */
	maxBytes?: number;
};

type FileIdentity = {
	device: bigint;
	inode: bigint;
};

type OpenFileSnapshot = FileIdentity & {
	size: bigint;
	mode: bigint;
	uid: bigint;
	nlink: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
};

const BOUNDED_READ_CHUNK_BYTES = 64 * 1024;

export class SecureFileTooLargeError extends Error {
	readonly code = "ERR_SECURE_FILE_TOO_LARGE";
	readonly filePath: string;
	readonly maxBytes: number;

	constructor(filePath: string, maxBytes: number, operation: "read" | "write" = "read") {
		super(`State file exceeds the secure ${operation} limit of ${maxBytes} bytes: ${filePath}`);
		this.name = "SecureFileTooLargeError";
		this.filePath = filePath;
		this.maxBytes = maxBytes;
	}
}

function validatedByteLimit(filePath: string, maxBytes: number, operation: "read" | "write"): number {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError(`Secure ${operation} byte limit must be a non-negative safe integer: ${filePath}`);
	}
	return maxBytes;
}

function oversizedReadError(filePath: string, maxBytes: number): Error {
	return new SecureFileTooLargeError(filePath, maxBytes);
}

function assertContentWithinLimit(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	options: SecureWriteFileOptions,
): void {
	if (options.maxBytes === undefined) return;
	const maxBytes = validatedByteLimit(filePath, options.maxBytes, "write");
	const contentBytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
	if (contentBytes > maxBytes) {
		throw new SecureFileTooLargeError(filePath, maxBytes, "write");
	}
}

function readBoundedFileSync(fd: number, filePath: string, maxBytes: number): Buffer {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (true) {
		const chunk = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, maxBytes - totalBytes + 1));
		const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
		if (bytesRead === 0) break;
		totalBytes += bytesRead;
		if (totalBytes > maxBytes) throw oversizedReadError(filePath, maxBytes);
		chunks.push(chunk.subarray(0, bytesRead));
	}
	return Buffer.concat(chunks, totalBytes);
}

async function readBoundedFile(
	handle: Awaited<ReturnType<typeof open>>,
	filePath: string,
	maxBytes: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (true) {
		const chunk = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, maxBytes - totalBytes + 1));
		const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
		if (bytesRead === 0) break;
		totalBytes += bytesRead;
		if (totalBytes > maxBytes) throw oversizedReadError(filePath, maxBytes);
		chunks.push(chunk.subarray(0, bytesRead));
	}
	return Buffer.concat(chunks, totalBytes);
}

function openNoFollowFlags(flags: number): number {
	return process.platform === "win32" ? flags : flags | constants.O_NOFOLLOW;
}

function currentUid(): bigint | undefined {
	return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function assertOwner(uid: bigint, path: string): void {
	const expected = currentUid();
	if (expected !== undefined && uid !== expected) {
		throw new Error(`State path is not owned by the current user: ${path}`);
	}
}

function assertDirectoryStats(stats: BigIntStats, path: string): void {
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`State parent is not a plain directory: ${path}`);
	}
	assertOwner(stats.uid, path);
}

function ensureParentDirectorySync(filePath: string): FileIdentity {
	const parent = dirname(filePath);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: DEFAULT_PRIVATE_DIRECTORY_MODE });
	const stats = lstatSync(parent, { bigint: true });
	assertDirectoryStats(stats, parent);
	return { device: stats.dev, inode: stats.ino };
}

async function ensureParentDirectory(filePath: string): Promise<FileIdentity> {
	const parent = dirname(filePath);
	await mkdir(parent, { recursive: true, mode: DEFAULT_PRIVATE_DIRECTORY_MODE });
	const stats = await lstat(parent, { bigint: true });
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`State parent is not a plain directory: ${parent}`);
	}
	assertOwner(stats.uid, parent);
	return { device: stats.dev, inode: stats.ino };
}

function assertParentIdentitySync(filePath: string, identity: FileIdentity): void {
	const parent = dirname(filePath);
	const stats = lstatSync(parent, { bigint: true });
	assertDirectoryStats(stats, parent);
	if (stats.dev !== identity.device || stats.ino !== identity.inode) {
		throw new Error(`State parent changed during atomic replacement: ${parent}`);
	}
}

async function assertParentIdentity(filePath: string, identity: FileIdentity): Promise<void> {
	const parent = dirname(filePath);
	const stats = await lstat(parent, { bigint: true });
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`State parent is not a plain directory: ${parent}`);
	}
	assertOwner(stats.uid, parent);
	if (stats.dev !== identity.device || stats.ino !== identity.inode) {
		throw new Error(`State parent changed during atomic replacement: ${parent}`);
	}
}

function regularTargetIdentitySync(filePath: string, options: SecureFileOptions): FileIdentity | undefined {
	let stats: BigIntStats;
	try {
		stats = lstatSync(filePath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`State path is not a plain file: ${filePath}`);
	}
	assertOwner(stats.uid, filePath);
	if ((options.requireSingleLink ?? true) && stats.nlink !== 1n) {
		throw new Error(`State path has multiple hard links: ${filePath}`);
	}
	if ((options.requireOwnerWritable ?? true) && process.platform !== "win32" && (stats.mode & 0o200n) === 0n) {
		throw new Error(`State path is not owner-writable: ${filePath}`);
	}
	return { device: stats.dev, inode: stats.ino };
}

async function regularTargetIdentity(filePath: string, options: SecureFileOptions): Promise<FileIdentity | undefined> {
	let stats: BigIntStats;
	try {
		stats = await lstat(filePath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`State path is not a plain file: ${filePath}`);
	}
	assertOwner(stats.uid, filePath);
	if ((options.requireSingleLink ?? true) && stats.nlink !== 1n) {
		throw new Error(`State path has multiple hard links: ${filePath}`);
	}
	if ((options.requireOwnerWritable ?? true) && process.platform !== "win32" && (stats.mode & 0o200n) === 0n) {
		throw new Error(`State path is not owner-writable: ${filePath}`);
	}
	return { device: stats.dev, inode: stats.ino };
}

function assertSameTargetIdentity(
	filePath: string,
	before: FileIdentity | undefined,
	after: FileIdentity | undefined,
): void {
	if (
		(before === undefined) !== (after === undefined) ||
		(before !== undefined && after !== undefined && (before.device !== after.device || before.inode !== after.inode))
	) {
		throw new Error(`State path changed during atomic replacement: ${filePath}`);
	}
}

function assertOpenFileIdentity(
	filePath: string,
	stats: BigIntStats,
	expected: FileIdentity,
	options: SecureFileOptions,
): void {
	if (!stats.isFile()) throw new Error(`State path is not a plain file: ${filePath}`);
	assertOwner(stats.uid, filePath);
	if ((options.requireSingleLink ?? true) && stats.nlink !== 1n) {
		throw new Error(`State path has multiple hard links: ${filePath}`);
	}
	if ((options.requireOwnerWritable ?? true) && process.platform !== "win32" && (stats.mode & 0o200n) === 0n) {
		throw new Error(`State path is not owner-writable: ${filePath}`);
	}
	if (stats.dev !== expected.device || stats.ino !== expected.inode) {
		throw new Error(`State path changed while it was open: ${filePath}`);
	}
}

function openFileSnapshot(stats: BigIntStats): OpenFileSnapshot {
	return {
		device: stats.dev,
		inode: stats.ino,
		size: stats.size,
		mode: stats.mode,
		uid: stats.uid,
		nlink: stats.nlink,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

function assertStableOpenFile(filePath: string, before: OpenFileSnapshot, after: OpenFileSnapshot): void {
	for (const field of Object.keys(before) as Array<keyof OpenFileSnapshot>) {
		if (before[field] !== after[field]) {
			throw new Error(`State path changed during secure read: ${filePath}`);
		}
	}
}

function syncDirectorySync(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || !["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
			throw error;
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || !["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
			throw error;
		}
	} finally {
		await handle?.close();
	}
}

function temporaryPathFor(filePath: string): string {
	return join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
}

/**
 * Replace a state file without exposing truncated bytes. Callers sharing a path
 * across processes must hold {@link withSecureFileLockSync} around read-modify-write.
 */
export function secureAtomicReplaceFileSync(
	filePath: string,
	write: (fd: number) => void,
	options: SecureFileOptions = {},
): void {
	const mode = options.mode ?? DEFAULT_PRIVATE_FILE_MODE;
	const parentIdentity = ensureParentDirectorySync(filePath);
	const targetIdentity = regularTargetIdentitySync(filePath, options);
	const temporaryPath = temporaryPathFor(filePath);
	let fd: number | undefined;
	try {
		fd = openSync(temporaryPath, "wx", mode);
		write(fd);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		assertParentIdentitySync(filePath, parentIdentity);
		assertSameTargetIdentity(filePath, targetIdentity, regularTargetIdentitySync(filePath, options));
		renameSync(temporaryPath, filePath);
		chmodSync(filePath, mode);
		regularTargetIdentitySync(filePath, { ...options, requireOwnerWritable: false });
		syncDirectorySync(dirname(filePath));
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original failure. The random, owner-created path is never reused.
		}
	}
}

export function secureAtomicWriteFileSync(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	options: SecureWriteFileOptions = {},
): void {
	assertContentWithinLimit(filePath, content, options);
	secureAtomicReplaceFileSync(filePath, (fd) => writeFileSync(fd, content), options);
}

/** Validate an existing state file before reading it. Returns false only for ENOENT. */
export function secureFileExistsSync(filePath: string, options: SecureFileOptions = {}): boolean {
	const parent = dirname(filePath);
	let parentStats: BigIntStats;
	try {
		parentStats = lstatSync(parent, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	assertDirectoryStats(parentStats, parent);
	return regularTargetIdentitySync(filePath, { ...options, requireOwnerWritable: false }) !== undefined;
}

/** Async counterpart of {@link secureFileExistsSync}. */
export async function secureFileExists(filePath: string, options: SecureFileOptions = {}): Promise<boolean> {
	const parent = dirname(filePath);
	let parentStats: BigIntStats;
	try {
		parentStats = await lstat(parent, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
		throw new Error(`State parent is not a plain directory: ${parent}`);
	}
	assertOwner(parentStats.uid, parent);
	return (await regularTargetIdentity(filePath, { ...options, requireOwnerWritable: false })) !== undefined;
}

/** Read one owner-controlled regular file without following a replaced link. */
export function secureReadFileSync(filePath: string, options: SecureReadFileOptions): Buffer {
	const parent = dirname(filePath);
	const parentStats = lstatSync(parent, { bigint: true });
	assertDirectoryStats(parentStats, parent);
	const parentIdentity = { device: parentStats.dev, inode: parentStats.ino };
	const readOptions = { ...options, requireOwnerWritable: false };
	const targetIdentity = regularTargetIdentitySync(filePath, readOptions);
	if (!targetIdentity) throw new Error(`State path does not exist: ${filePath}`);
	const maxBytes = validatedByteLimit(filePath, options.maxBytes, "read");
	const fd = openSync(filePath, openNoFollowFlags(constants.O_RDONLY));
	try {
		const initialStats = fstatSync(fd, { bigint: true });
		assertOpenFileIdentity(filePath, initialStats, targetIdentity, readOptions);
		if (initialStats.size > BigInt(maxBytes)) throw oversizedReadError(filePath, maxBytes);
		const content = readBoundedFileSync(fd, filePath, maxBytes);
		const finalStats = fstatSync(fd, { bigint: true });
		assertOpenFileIdentity(filePath, finalStats, targetIdentity, readOptions);
		assertStableOpenFile(filePath, openFileSnapshot(initialStats), openFileSnapshot(finalStats));
		assertSameTargetIdentity(filePath, targetIdentity, regularTargetIdentitySync(filePath, readOptions));
		assertParentIdentitySync(filePath, parentIdentity);
		return content;
	} finally {
		closeSync(fd);
	}
}

/** Async counterpart of {@link secureReadFileSync}. */
export async function secureReadFile(filePath: string, options: SecureReadFileOptions): Promise<Buffer> {
	const parent = dirname(filePath);
	const parentStats = await lstat(parent, { bigint: true });
	if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
		throw new Error(`State parent is not a plain directory: ${parent}`);
	}
	assertOwner(parentStats.uid, parent);
	const parentIdentity = { device: parentStats.dev, inode: parentStats.ino };
	const readOptions = { ...options, requireOwnerWritable: false };
	const targetIdentity = await regularTargetIdentity(filePath, readOptions);
	if (!targetIdentity) throw new Error(`State path does not exist: ${filePath}`);
	const maxBytes = validatedByteLimit(filePath, options.maxBytes, "read");
	const handle = await open(filePath, openNoFollowFlags(constants.O_RDONLY));
	try {
		const initialStats = await handle.stat({ bigint: true });
		assertOpenFileIdentity(filePath, initialStats, targetIdentity, readOptions);
		if (initialStats.size > BigInt(maxBytes)) throw oversizedReadError(filePath, maxBytes);
		const content = await readBoundedFile(handle, filePath, maxBytes);
		const finalStats = await handle.stat({ bigint: true });
		assertOpenFileIdentity(filePath, finalStats, targetIdentity, readOptions);
		assertStableOpenFile(filePath, openFileSnapshot(initialStats), openFileSnapshot(finalStats));
		assertSameTargetIdentity(filePath, targetIdentity, await regularTargetIdentity(filePath, readOptions));
		await assertParentIdentity(filePath, parentIdentity);
		return content;
	} finally {
		await handle.close();
	}
}

export function secureAppendFileSync(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	options: SecureFileOptions = {},
): void {
	const mode = options.mode ?? DEFAULT_PRIVATE_FILE_MODE;
	const parentIdentity = ensureParentDirectorySync(filePath);
	const targetIdentity = regularTargetIdentitySync(filePath, options);
	if (!targetIdentity) throw new Error(`State path does not exist: ${filePath}`);
	assertParentIdentitySync(filePath, parentIdentity);
	const fd = openSync(filePath, openNoFollowFlags(constants.O_WRONLY | constants.O_APPEND), mode);
	try {
		assertOpenFileIdentity(filePath, fstatSync(fd, { bigint: true }), targetIdentity, options);
		writeFileSync(fd, content);
		fchmodSync(fd, mode);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export async function secureAtomicWriteFile(
	filePath: string,
	content: string | Uint8Array,
	options: SecureWriteFileOptions = {},
): Promise<void> {
	assertContentWithinLimit(filePath, content, options);
	const mode = options.mode ?? DEFAULT_PRIVATE_FILE_MODE;
	const parentIdentity = await ensureParentDirectory(filePath);
	const targetIdentity = await regularTargetIdentity(filePath, options);
	const temporaryPath = temporaryPathFor(filePath);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", mode);
		await handle.writeFile(content);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await assertParentIdentity(filePath, parentIdentity);
		assertSameTargetIdentity(filePath, targetIdentity, await regularTargetIdentity(filePath, options));
		await rename(temporaryPath, filePath);
		await chmod(filePath, mode);
		await regularTargetIdentity(filePath, { ...options, requireOwnerWritable: false });
		await syncDirectory(dirname(filePath));
	} finally {
		await handle?.close();
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function acquireLockSync(filePath: string): () => void {
	ensureParentDirectorySync(filePath);
	let lastError: unknown;
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			return lockfile.lockSync(dirname(filePath), {
				realpath: false,
				lockfilePath: `${filePath}.lock`,
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ELOCKED" || attempt === 10) throw error;
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < 20) {
				// Synchronous callers cannot yield while preserving their public contract.
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(`Failed to lock state file: ${filePath}`);
}

export function withSecureFileLockSync<T>(filePath: string, fn: () => T): T {
	const release = acquireLockSync(filePath);
	try {
		return fn();
	} finally {
		release();
	}
}

export async function withSecureFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	await ensureParentDirectory(filePath);
	let compromised: Error | undefined;
	const release = await lockfile.lock(dirname(filePath), {
		realpath: false,
		lockfilePath: `${filePath}.lock`,
		retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
		stale: 30_000,
		onCompromised: (error) => {
			compromised = error;
		},
	});
	try {
		if (compromised) throw compromised;
		const result = await fn();
		if (compromised) throw compromised;
		return result;
	} finally {
		await release().catch(() => undefined);
	}
}
