import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_TEMPS_PER_RUN = 16;

export type AtomicExecutableOptions = {
	content: Uint8Array;
	destinationPath: string;
	trustedRoot: string;
	directoryMode?: number;
	executableMode?: number;
	/** Refuse to replace different bytes at an already-published destination. */
	immutableDestination?: boolean;
	/** Require every directory to be owner-controlled and not group/world-writable. */
	requireSecureDirectoryTree?: boolean;
	/** @internal Deterministic interleaving/fault injection for focused tests. */
	testBeforeRename?(temporaryPath: string): void;
	/** @internal Deterministic stale-temp cleanup clock for focused tests. */
	testNowMs?: number;
};

export type ContentAddressedExecutableOptions = {
	content: Uint8Array;
	/** Tool-specific cache directory, for example ~/.magenta/cache/rg. */
	cacheDirectory: string;
	/** Final filename below the SHA-256 directory. */
	executableName: string;
	/** Existing owner-controlled ancestor of cacheDirectory. */
	trustedRoot: string;
	/** @internal Deterministic interleaving/fault injection for focused tests. */
	testBeforeRename?(temporaryPath: string): void;
	/** @internal Deterministic stale-temp cleanup clock for focused tests. */
	testNowMs?: number;
};

type OwnedFileSnapshot = {
	dev: number | bigint;
	ino: number | bigint;
	mode: number;
	sha256: string;
};

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function assertNormalizedAbsolutePath(path: string, label: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
}

function pathIsWithin(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function assertOwned(stats: { uid: number }, path: string): void {
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Executable materialization path is not owned by the current user: ${path}`);
	}
}

function assertOwnedDirectory(path: string, requireSecureMode: boolean): void {
	const stats = lstatSync(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Executable materialization directory is not a real directory: ${path}`);
	}
	assertOwned(stats, path);
	if (requireSecureMode && process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
		throw new Error(`Executable materialization directory is group/world-writable: ${path}`);
	}
}

function ensureOwnedDirectoryTree(
	trustedRoot: string,
	targetDirectory: string,
	mode: number,
	requireSecureMode: boolean,
): void {
	assertOwnedDirectory(trustedRoot, requireSecureMode);
	const pathFromRoot = relative(trustedRoot, targetDirectory);
	if (!pathFromRoot || pathFromRoot === ".") return;
	if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
		throw new Error("Executable destination escapes its trusted root");
	}
	let current = trustedRoot;
	for (const part of pathFromRoot.split(sep)) {
		if (!part || part === "." || part === "..") throw new Error("Executable destination has an unsafe directory");
		current = join(current, part);
		try {
			mkdirSync(current, { mode });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		assertOwnedDirectory(current, requireSecureMode);
	}
}

/** Ensure an owner-controlled, link-free private directory below a trusted root. */
export function ensureSecureExecutableCacheDirectory(cacheDirectory: string, trustedRoot: string): void {
	assertNormalizedAbsolutePath(cacheDirectory, "Executable cache directory");
	assertNormalizedAbsolutePath(trustedRoot, "Executable trusted root");
	const normalizedCacheDirectory = resolve(cacheDirectory);
	const normalizedTrustedRoot = resolve(trustedRoot);
	if (
		normalizedCacheDirectory === normalizedTrustedRoot ||
		!pathIsWithin(normalizedTrustedRoot, normalizedCacheDirectory)
	) {
		throw new Error("Executable cache directory must be below its trusted root");
	}
	ensureOwnedDirectoryTree(normalizedTrustedRoot, normalizedCacheDirectory, 0o700, true);
}

function openNoFollowFlags(baseFlags: number): number {
	return process.platform === "win32" ? baseFlags : baseFlags | constants.O_NOFOLLOW;
}

function readOwnedRegularFile(path: string): OwnedFileSnapshot | undefined {
	let pathStats: ReturnType<typeof lstatSync>;
	try {
		pathStats = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
		throw new Error(`Executable destination is not a regular file: ${path}`);
	}
	assertOwned(pathStats, path);

	const descriptor = openSync(path, openNoFollowFlags(constants.O_RDONLY));
	try {
		const openStats = fstatSync(descriptor);
		if (!openStats.isFile() || openStats.dev !== pathStats.dev || openStats.ino !== pathStats.ino) {
			throw new Error(`Executable destination changed while it was inspected: ${path}`);
		}
		assertOwned(openStats, path);
		return {
			dev: openStats.dev,
			ino: openStats.ino,
			mode: openStats.mode,
			sha256: sha256(readFileSync(descriptor)),
		};
	} finally {
		closeSync(descriptor);
	}
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || !["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
			throw error;
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function tempPrefix(destinationPath: string): string {
	return `.${basename(destinationPath)}.magenta-tmp-`;
}

function cleanupStaleTemps(directory: string, destinationPath: string, nowMs: number): void {
	const prefix = tempPrefix(destinationPath);
	const temporaryNamePattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\d+-[0-9a-f]{24}$`, "u");
	let removed = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (removed >= MAX_STALE_TEMPS_PER_RUN || !temporaryNamePattern.test(entry.name)) continue;
		const path = join(directory, entry.name);
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!stats.isFile() || stats.isSymbolicLink()) continue;
		assertOwned(stats, path);
		if (stats.mtimeMs > nowMs - STALE_TEMP_AGE_MS) continue;
		rmSync(path, { force: false });
		removed += 1;
	}
	if (removed > 0) syncDirectory(directory);
}

function createExclusiveTemp(directory: string, destinationPath: string, content: Uint8Array, mode: number): string {
	const prefix = tempPrefix(destinationPath);
	for (let attempt = 0; attempt < 8; attempt++) {
		const path = join(directory, `${prefix}${process.pid}-${randomBytes(12).toString("hex")}`);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(
				path,
				openNoFollowFlags(constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY),
				mode,
			);
			writeFileSync(descriptor, content);
			fchmodSync(descriptor, mode);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			return path;
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			rmSync(path, { force: true });
			throw error;
		}
	}
	throw new Error(`Could not allocate an exclusive executable staging file for ${destinationPath}`);
}

function ensureExecutableMode(path: string, snapshot: OwnedFileSnapshot, mode: number): void {
	if ((snapshot.mode & 0o777) === mode) return;
	const descriptor = openSync(path, openNoFollowFlags(constants.O_RDONLY));
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile() || before.dev !== snapshot.dev || before.ino !== snapshot.ino) {
			throw new Error(`Executable destination changed while permissions were applied: ${path}`);
		}
		assertOwned(before, path);
		fchmodSync(descriptor, mode);
		fsyncSync(descriptor);
		if ((fstatSync(descriptor).mode & 0o777) !== mode) {
			throw new Error(`Executable permissions were not applied: ${path}`);
		}
	} finally {
		closeSync(descriptor);
	}
}

/** Materialize complete executable bytes without exposing a partial final path. */
export function materializeExecutableAtomically(options: AtomicExecutableOptions): string {
	const destinationPath = resolve(options.destinationPath);
	const trustedRoot = resolve(options.trustedRoot);
	assertNormalizedAbsolutePath(options.destinationPath, "Executable destination");
	assertNormalizedAbsolutePath(options.trustedRoot, "Executable trusted root");
	if (destinationPath === trustedRoot || !pathIsWithin(trustedRoot, destinationPath)) {
		throw new Error("Executable destination must be below its trusted root");
	}
	const directoryMode = options.directoryMode ?? 0o700;
	const executableMode = options.executableMode ?? 0o755;
	if ((directoryMode & ~0o777) !== 0 || (executableMode & ~0o777) !== 0 || executableMode === 0) {
		throw new Error("Executable materialization modes are invalid");
	}
	if (options.requireSecureDirectoryTree && process.platform !== "win32" && (directoryMode & 0o022) !== 0) {
		throw new Error("Secure executable cache directories cannot be group/world-writable");
	}

	const directory = dirname(destinationPath);
	ensureOwnedDirectoryTree(trustedRoot, directory, directoryMode, options.requireSecureDirectoryTree === true);
	cleanupStaleTemps(directory, destinationPath, options.testNowMs ?? Date.now());
	const expectedHash = sha256(options.content);
	const initial = readOwnedRegularFile(destinationPath);
	if (initial?.sha256 === expectedHash) {
		ensureExecutableMode(destinationPath, initial, executableMode);
		return destinationPath;
	}
	if (initial && options.immutableDestination) {
		throw new Error(`Immutable executable destination contains unexpected bytes: ${destinationPath}`);
	}

	const temporaryPath = createExclusiveTemp(directory, destinationPath, options.content, executableMode);
	try {
		options.testBeforeRename?.(temporaryPath);
		ensureOwnedDirectoryTree(trustedRoot, directory, directoryMode, options.requireSecureDirectoryTree === true);
		const current = readOwnedRegularFile(destinationPath);
		if (current?.sha256 === expectedHash) {
			ensureExecutableMode(destinationPath, current, executableMode);
			return destinationPath;
		}
		if (current && options.immutableDestination) {
			throw new Error(`Immutable executable destination contains unexpected bytes: ${destinationPath}`);
		}
		if (
			(initial === undefined && current !== undefined) ||
			(initial !== undefined &&
				(current === undefined || current.dev !== initial.dev || current.ino !== initial.ino))
		) {
			throw new Error(`Executable destination changed during atomic materialization: ${destinationPath}`);
		}
		if (options.immutableDestination) {
			try {
				linkSync(temporaryPath, destinationPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const winner = readOwnedRegularFile(destinationPath);
				if (winner?.sha256 !== expectedHash) {
					throw new Error(`Immutable executable destination contains unexpected bytes: ${destinationPath}`);
				}
				ensureExecutableMode(destinationPath, winner, executableMode);
				return destinationPath;
			}
		} else {
			renameSync(temporaryPath, destinationPath);
		}
		syncDirectory(directory);
		const installed = readOwnedRegularFile(destinationPath);
		if (!installed || installed.sha256 !== expectedHash) {
			throw new Error(`Atomically materialized executable failed final verification: ${destinationPath}`);
		}
		ensureExecutableMode(destinationPath, installed, executableMode);
		return destinationPath;
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

/** Materialize executable bytes under an immutable SHA-256-addressed cache path. */
export function materializeContentAddressedExecutable(options: ContentAddressedExecutableOptions): string {
	ensureSecureExecutableCacheDirectory(options.cacheDirectory, options.trustedRoot);
	if (
		!options.executableName ||
		options.executableName === "." ||
		options.executableName === ".." ||
		basename(options.executableName) !== options.executableName
	) {
		throw new Error("Content-addressed executable name must be one safe path component");
	}
	const destinationPath = join(options.cacheDirectory, sha256(options.content), options.executableName);
	return materializeExecutableAtomically({
		content: options.content,
		destinationPath,
		trustedRoot: options.trustedRoot,
		directoryMode: 0o700,
		executableMode: 0o755,
		immutableDestination: true,
		requireSecureDirectoryTree: true,
		testBeforeRename: options.testBeforeRename,
		testNowMs: options.testNowMs,
	});
}

/** Read-only helper used by cleanup diagnostics and focused tests. */
export function isAtomicallyMaterializedExecutable(path: string, expectedContent: Uint8Array): boolean {
	const snapshot = readOwnedRegularFile(path);
	return snapshot?.sha256 === sha256(expectedContent) && (snapshot.mode & 0o111) !== 0;
}
