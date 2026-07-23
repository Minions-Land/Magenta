import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync, lstatSync, readdirSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
	type OwnedPathSnapshot,
	ownedPathSnapshotMatches,
	removeOwnedPathIfUnchanged,
	snapshotOwnedPath,
} from "../../owned-path.ts";
import {
	getProcessInstanceStatus,
	getProcessStartIdentity,
	type ProcessInstanceStatus,
} from "../../process-instance.ts";
import {
	secureAtomicWriteFileSync,
	secureReadFile,
	secureReadFileSync,
	withSecureFileLock,
	withSecureFileLockSync,
} from "../secure-file.ts";
import {
	type ContentAddressedExecutableOptions,
	ensureSecureExecutableCacheDirectory,
	materializeContentAddressedExecutable,
} from "./atomic-executable.ts";

const GENERATION_SCHEMA = "magenta.helper-cache-generation.v1";
const LEASE_SCHEMA = "magenta.helper-cache-lease.v1";
const GENERATION_MANIFEST = ".magenta-generation.json";
const LEASE_DIRECTORY = ".magenta-leases";
const TRASH_DIRECTORY = ".magenta-trash";
const LOCK_STATE = ".magenta-helper-cache";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const QUARANTINE_PATTERN = /^([0-9a-f]{64})-([0-9a-f]{32})$/u;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const MAX_LEASES_PER_GENERATION = 128;
export const MAX_REGISTERED_HELPER_LEASES = 64;

export const DEFAULT_HELPER_CACHE_MAX_GENERATIONS = 3;
export const DEFAULT_HELPER_CACHE_MAX_UNUSED_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_HELPER_CACHE_MAX_SCANNED_GENERATIONS = 64;
export const DEFAULT_HELPER_CACHE_MAX_DELETIONS_PER_RUN = 2;
export const DEFAULT_HELPER_CACHE_MAX_STALE_LEASE_DELETIONS_PER_RUN = 32;

type GenerationManifest = {
	schema: typeof GENERATION_SCHEMA;
	digest: string;
	executableName: string;
	createdAt: number;
};

type GenerationLease = {
	schema: typeof LEASE_SCHEMA;
	digest: string;
	pid: number;
	processStartId: string | null;
	registeredAt: number;
};

type ProcessInstance = {
	pid: number;
	processStartId: string | null;
};

type StableFile = {
	content: Buffer;
	snapshot: OwnedPathSnapshot;
};

type LeaseInspection = {
	lease: GenerationLease;
	path: string;
	snapshot: OwnedPathSnapshot;
	status: ProcessInstanceStatus;
};

type ManagedGeneration = {
	digest: string;
	directoryPath: string;
	directorySnapshot: OwnedPathSnapshot;
	executablePath: string;
	executableSnapshot: OwnedPathSnapshot;
	manifestPath: string;
	manifestSnapshot: OwnedPathSnapshot;
	leaseDirectoryPath: string;
	leases: LeaseInspection[];
	manifest: GenerationManifest;
	protected: boolean;
};

type RegisteredLease = {
	executablePath: string;
	leasePath: string;
	lease: GenerationLease;
	digest: string;
	size: number;
};

export type LeasedContentAddressedExecutableOptions = ContentAddressedExecutableOptions & {
	/** @internal Disable the unref'ed best-effort maintenance task in focused tests. */
	testScheduleCleanup?: boolean;
	/** @internal Deterministic process identity for focused tests. */
	testProcessInstance?: ProcessInstance;
	/** @internal Deterministic lease/manifest clock for focused tests. */
	testNowMs?: number;
};

export type HelperCacheCleanupOptions = {
	cacheDirectory: string;
	trustedRoot: string;
	maxGenerations?: number;
	maxUnusedAgeMs?: number;
	maxScannedGenerations?: number;
	maxDeletions?: number;
	maxStaleLeaseDeletions?: number;
	nowMs?: number;
	/** @internal Deterministic PID-reuse/liveness probe for focused tests. */
	testProcessInstanceStatus?(pid: number, processStartId: string | null): ProcessInstanceStatus;
	/** @internal Deterministic path-race injection immediately before quarantine. */
	testBeforeClaim?(generationPath: string): void | Promise<void>;
};

export type HelperCacheCleanupResult = {
	scannedGenerations: number;
	managedGenerations: number;
	protectedGenerations: number;
	quarantinedGenerations: number;
	deletedGenerations: number;
	deletedBytes: number;
	deletedStaleLeases: number;
};

const registeredLeases = new Map<string, RegisteredLease>();
const scheduledCacheDirectories = new Set<string>();
/** A bounded second pass requested while a directory already has cleanup queued/running. */
const cleanupRerunRequested = new Set<string>();

function sha256(content: Uint8Array | string): string {
	return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function parseGenerationManifest(value: unknown): GenerationManifest | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ["schema", "digest", "executableName", "createdAt"])) {
		return undefined;
	}
	if (
		value.schema !== GENERATION_SCHEMA ||
		typeof value.digest !== "string" ||
		!DIGEST_PATTERN.test(value.digest) ||
		typeof value.executableName !== "string" ||
		!isSafeExecutableName(value.executableName) ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		value.createdAt < 0
	) {
		return undefined;
	}
	return value as GenerationManifest;
}

function parseLease(value: unknown): GenerationLease | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ["schema", "digest", "pid", "processStartId", "registeredAt"])) {
		return undefined;
	}
	if (
		value.schema !== LEASE_SCHEMA ||
		typeof value.digest !== "string" ||
		!DIGEST_PATTERN.test(value.digest) ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		(value.processStartId !== null && typeof value.processStartId !== "string") ||
		(typeof value.processStartId === "string" && value.processStartId.length > 1024) ||
		typeof value.registeredAt !== "number" ||
		!Number.isFinite(value.registeredAt) ||
		value.registeredAt < 0
	) {
		return undefined;
	}
	return value as GenerationLease;
}

function isSafeExecutableName(name: string): boolean {
	return Boolean(name) && name !== "." && name !== ".." && basename(name) === name;
}

function assertCleanupLimit(value: number, label: string, allowZero: boolean): number {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new TypeError(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
	}
	return value;
}

function lockStatePath(cacheDirectory: string): string {
	return join(cacheDirectory, LOCK_STATE);
}

function generationLeaseName(instance: ProcessInstance): string {
	return `${instance.pid}-${sha256(instance.processStartId ?? "unknown").slice(0, 24)}.json`;
}

function expectedLeaseName(lease: GenerationLease): string {
	return generationLeaseName({ pid: lease.pid, processStartId: lease.processStartId });
}

function readJsonFileSync(path: string): unknown {
	const content = secureReadFileSync(path, { requireOwnerWritable: false, maxBytes: MAX_METADATA_BYTES });
	return JSON.parse(content.toString("utf8")) as unknown;
}

function isMissingSecureRead(error: unknown): boolean {
	return (
		(error as NodeJS.ErrnoException).code === "ENOENT" ||
		(error instanceof Error && error.message.startsWith("State path does not exist:"))
	);
}

function sameLeaseIdentity(left: GenerationLease, right: GenerationLease): boolean {
	return (
		left.schema === right.schema &&
		left.digest === right.digest &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId
	);
}

function leaseFastPathIsValid(entry: RegisteredLease): boolean {
	try {
		const content = secureReadFileSync(entry.executablePath, {
			requireOwnerWritable: false,
			maxBytes: MAX_EXECUTABLE_BYTES,
		});
		if (content.byteLength !== entry.size || sha256(content) !== entry.digest) return false;
		const stats = lstatSync(entry.executablePath);
		if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) return false;
		const lease = parseLease(readJsonFileSync(entry.leasePath));
		return lease !== undefined && sameLeaseIdentity(lease, entry.lease);
	} catch {
		return false;
	}
}

function rememberRegisteredLease(cacheKey: string, entry: RegisteredLease): void {
	// Map insertion order is the LRU order. A hit moves the entry to the tail;
	// evicting only the oldest index entry bounds retained metadata and bytes.
	registeredLeases.delete(cacheKey);
	registeredLeases.set(cacheKey, entry);
	while (registeredLeases.size > MAX_REGISTERED_HELPER_LEASES) {
		const oldest = registeredLeases.keys().next().value;
		if (oldest === undefined) break;
		registeredLeases.delete(oldest);
	}
}

/** Remove only indexes whose executable path was not recreated after GC. */
function pruneMissingRegisteredLeases(cacheDirectory: string): void {
	const prefix = `${resolve(cacheDirectory)}\u0000`;
	for (const [cacheKey, entry] of registeredLeases) {
		if (!cacheKey.startsWith(prefix)) continue;
		try {
			lstatSync(entry.executablePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") registeredLeases.delete(cacheKey);
		}
	}
}

/** @internal Test-only diagnostic; the runtime contract is the bounded cache itself. */
export function getRegisteredHelperLeaseCacheForTests(): readonly string[] {
	return [...registeredLeases.keys()];
}

function registerGenerationLease(
	generationDirectory: string,
	manifest: GenerationManifest,
	instance: ProcessInstance,
	trustedRoot: string,
	nowMs: number,
): { lease: GenerationLease; leasePath: string } {
	const leaseDirectory = join(generationDirectory, LEASE_DIRECTORY);
	ensureSecureExecutableCacheDirectory(leaseDirectory, trustedRoot);
	const lease: GenerationLease = {
		schema: LEASE_SCHEMA,
		digest: manifest.digest,
		pid: instance.pid,
		processStartId: instance.processStartId,
		registeredAt: nowMs,
	};
	const leasePath = join(leaseDirectory, generationLeaseName(instance));
	let existing: GenerationLease | undefined;
	try {
		existing = parseLease(readJsonFileSync(leasePath));
	} catch (error) {
		if (!isMissingSecureRead(error)) throw error;
	}
	if (!existing || !sameLeaseIdentity(existing, lease)) {
		secureAtomicWriteFileSync(leasePath, `${JSON.stringify(lease)}\n`, {
			mode: 0o600,
			maxBytes: MAX_METADATA_BYTES,
		});
	}
	return { lease: existing && sameLeaseIdentity(existing, lease) ? existing : lease, leasePath };
}

function scheduleHelperCacheCleanup(cacheDirectory: string, trustedRoot: string): void {
	const key = resolve(cacheDirectory);
	if (scheduledCacheDirectories.has(key)) {
		// Materialization can race the timer or the async filesystem pass. Keep one
		// dirty bit so the completed pass is followed by at most one fresh scan.
		cleanupRerunRequested.add(key);
		return;
	}
	scheduledCacheDirectories.add(key);
	const timer = setTimeout(() => {
		void cleanupContentAddressedHelperCache({ cacheDirectory: key, trustedRoot })
			.catch(() => undefined)
			.finally(() => {
				scheduledCacheDirectories.delete(key);
				if (cleanupRerunRequested.delete(key)) scheduleHelperCacheCleanup(key, trustedRoot);
			});
	}, 0);
	timer.unref?.();
}

/**
 * Publish immutable helper bytes and register this exact process lifetime before
 * the path escapes the cache lock. Repeated lookups are read-only fast paths.
 */
export function materializeLeasedContentAddressedExecutable(options: LeasedContentAddressedExecutableOptions): string {
	if (!isSafeExecutableName(options.executableName)) {
		throw new Error("Content-addressed executable name must be one safe path component");
	}
	ensureSecureExecutableCacheDirectory(options.cacheDirectory, options.trustedRoot);
	const digest = sha256(options.content);
	const generationDirectory = join(options.cacheDirectory, digest);
	const executablePath = join(generationDirectory, options.executableName);
	const processInstance = options.testProcessInstance ?? {
		pid: process.pid,
		processStartId: getProcessStartIdentity(process.pid),
	};
	if (!Number.isSafeInteger(processInstance.pid) || processInstance.pid <= 0) {
		throw new TypeError("Helper cache lease PID must be a positive safe integer");
	}
	const cacheKey = `${resolve(options.cacheDirectory)}\u0000${digest}\u0000${options.executableName}`;
	const registered = registeredLeases.get(cacheKey);
	if (registered && leaseFastPathIsValid(registered)) {
		rememberRegisteredLease(cacheKey, registered);
		return registered.executablePath;
	}
	if (registered) registeredLeases.delete(cacheKey);

	const nowMs = options.testNowMs ?? Date.now();
	let registration: { lease: GenerationLease; leasePath: string } | undefined;
	withSecureFileLockSync(lockStatePath(options.cacheDirectory), () => {
		ensureSecureExecutableCacheDirectory(options.cacheDirectory, options.trustedRoot);
		const generationExisted = existsSync(generationDirectory);
		materializeContentAddressedExecutable(options);

		const manifestPath = join(generationDirectory, GENERATION_MANIFEST);
		let manifest: GenerationManifest | undefined;
		try {
			manifest = parseGenerationManifest(readJsonFileSync(manifestPath));
		} catch {
			manifest = undefined;
		}
		if (!generationExisted && !manifest) {
			manifest = {
				schema: GENERATION_SCHEMA,
				digest,
				executableName: options.executableName,
				createdAt: nowMs,
			};
			// The marker is the GC ownership signal. Publish it only after the first
			// lease, so even a stale-lock takeover can never observe a managed but
			// temporarily unleased generation.
			registration = registerGenerationLease(
				generationDirectory,
				manifest,
				processInstance,
				options.trustedRoot,
				nowMs,
			);
			secureAtomicWriteFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, {
				mode: 0o600,
				maxBytes: MAX_METADATA_BYTES,
			});
		}
		// A pre-existing directory without our exact marker predates lease-aware
		// publication. It remains usable but is deliberately never adopted by GC.
		if (!manifest || manifest.digest !== digest || manifest.executableName !== options.executableName) return;
		registration ??= registerGenerationLease(
			generationDirectory,
			manifest,
			processInstance,
			options.trustedRoot,
			nowMs,
		);
	});
	if (registration) {
		rememberRegisteredLease(cacheKey, {
			executablePath,
			lease: registration.lease,
			leasePath: registration.leasePath,
			digest,
			size: options.content.byteLength,
		});
	}
	if (options.testScheduleCleanup !== false) scheduleHelperCacheCleanup(options.cacheDirectory, options.trustedRoot);
	return executablePath;
}

async function readStableOwnedFile(path: string, maxBytes: number): Promise<StableFile | undefined> {
	const before = await snapshotOwnedPath(path, "file");
	if (!before || before.size > maxBytes) return undefined;
	let content: Buffer;
	try {
		content = await secureReadFile(path, { requireOwnerWritable: false, maxBytes });
	} catch {
		return undefined;
	}
	const after = await snapshotOwnedPath(path, "file");
	if (!after || !ownedPathSnapshotMatches(before, after)) return undefined;
	return { content, snapshot: after };
}

async function inspectManagedGeneration(
	directoryPath: string,
	digest: string,
	statusFor: (pid: number, processStartId: string | null) => ProcessInstanceStatus,
): Promise<ManagedGeneration | undefined> {
	const directorySnapshot = await snapshotOwnedPath(directoryPath, "directory");
	if (!directorySnapshot) return undefined;
	let entries: Dirent<string>[];
	try {
		entries = await readdir(directoryPath, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const entryNames = new Set(entries.map((entry) => entry.name));
	if (entryNames.size !== 3 || !entryNames.has(GENERATION_MANIFEST) || !entryNames.has(LEASE_DIRECTORY)) {
		return undefined;
	}
	const manifestPath = join(directoryPath, GENERATION_MANIFEST);
	const manifestFile = await readStableOwnedFile(manifestPath, MAX_METADATA_BYTES);
	if (!manifestFile) return undefined;
	let manifest: GenerationManifest | undefined;
	try {
		manifest = parseGenerationManifest(JSON.parse(manifestFile.content.toString("utf8")) as unknown);
	} catch {
		return undefined;
	}
	if (!manifest || manifest.digest !== digest || !entryNames.has(manifest.executableName)) return undefined;
	const executablePath = join(directoryPath, manifest.executableName);
	let executableSnapshot = await snapshotOwnedPath(executablePath, "file");
	if (!executableSnapshot) return undefined;
	const leaseDirectoryPath = join(directoryPath, LEASE_DIRECTORY);
	if (!(await snapshotOwnedPath(leaseDirectoryPath, "directory"))) return undefined;
	let leaseEntries: Dirent<string>[];
	try {
		leaseEntries = await readdir(leaseDirectoryPath, { withFileTypes: true });
	} catch {
		return undefined;
	}
	leaseEntries.sort((left, right) => left.name.localeCompare(right.name));
	const leases: LeaseInspection[] = [];
	let protectedGeneration = leaseEntries.length > MAX_LEASES_PER_GENERATION;
	for (const entry of leaseEntries.slice(0, MAX_LEASES_PER_GENERATION)) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) return undefined;
		const path = join(leaseDirectoryPath, entry.name);
		const leaseFile = await readStableOwnedFile(path, MAX_METADATA_BYTES);
		if (!leaseFile) return undefined;
		let lease: GenerationLease | undefined;
		try {
			lease = parseLease(JSON.parse(leaseFile.content.toString("utf8")) as unknown);
		} catch {
			return undefined;
		}
		if (!lease || lease.digest !== digest || entry.name !== expectedLeaseName(lease)) return undefined;
		const status = statusFor(lease.pid, lease.processStartId);
		if (status !== "dead") protectedGeneration = true;
		leases.push({ lease, path, snapshot: leaseFile.snapshot, status });
	}
	if (protectedGeneration) {
		const finalExecutableSnapshot = await snapshotOwnedPath(executablePath, "file");
		if (!finalExecutableSnapshot || !ownedPathSnapshotMatches(executableSnapshot, finalExecutableSnapshot)) {
			return undefined;
		}
		executableSnapshot = finalExecutableSnapshot;
	} else {
		const executableFile = await readStableOwnedFile(executablePath, MAX_EXECUTABLE_BYTES);
		if (!executableFile || sha256(executableFile.content) !== digest) return undefined;
		executableSnapshot = executableFile.snapshot;
	}
	const finalDirectorySnapshot = await snapshotOwnedPath(directoryPath, "directory");
	if (!finalDirectorySnapshot || !ownedPathSnapshotMatches(directorySnapshot, finalDirectorySnapshot))
		return undefined;
	return {
		digest,
		directoryPath,
		directorySnapshot: finalDirectorySnapshot,
		executablePath,
		executableSnapshot,
		manifestPath,
		manifestSnapshot: manifestFile.snapshot,
		leaseDirectoryPath,
		leases,
		manifest,
		protected: protectedGeneration,
	};
}

async function restoreQuarantine(quarantinePath: string, originalPath: string): Promise<void> {
	if (existsSync(originalPath)) return;
	await rename(quarantinePath, originalPath).catch(() => undefined);
}

async function deleteQuarantinedGeneration(
	path: string,
	digest: string,
	statusFor: (pid: number, processStartId: string | null) => ProcessInstanceStatus,
): Promise<{ deleted: boolean; bytes: number }> {
	const generation = await inspectManagedGeneration(path, digest, statusFor);
	if (!generation || generation.protected || generation.leases.some((lease) => lease.status !== "dead")) {
		return { deleted: false, bytes: 0 };
	}
	const bytes =
		generation.executableSnapshot.size +
		generation.manifestSnapshot.size +
		generation.leases.reduce((total, lease) => total + lease.snapshot.size, 0);
	for (const lease of generation.leases) {
		if (!(await removeOwnedPathIfUnchanged(lease.path, lease.snapshot))) return { deleted: false, bytes: 0 };
	}
	const leaseDirectorySnapshot = await snapshotOwnedPath(generation.leaseDirectoryPath, "directory");
	if (
		!leaseDirectorySnapshot ||
		!(await removeOwnedPathIfUnchanged(generation.leaseDirectoryPath, leaseDirectorySnapshot))
	) {
		return { deleted: false, bytes: 0 };
	}
	if (!(await removeOwnedPathIfUnchanged(generation.executablePath, generation.executableSnapshot))) {
		return { deleted: false, bytes: 0 };
	}
	if (!(await removeOwnedPathIfUnchanged(generation.manifestPath, generation.manifestSnapshot))) {
		return { deleted: false, bytes: 0 };
	}
	const directorySnapshot = await snapshotOwnedPath(path, "directory");
	if (!directorySnapshot || !(await removeOwnedPathIfUnchanged(path, directorySnapshot))) {
		return { deleted: false, bytes: 0 };
	}
	return { deleted: true, bytes };
}

/**
 * Reclaim only lease-aware helper generations. Active or unprobeable process
 * instances, unknown layouts, links, inode changes, and lock races all retain.
 */
export async function cleanupContentAddressedHelperCache(
	options: HelperCacheCleanupOptions,
): Promise<HelperCacheCleanupResult> {
	const result: HelperCacheCleanupResult = {
		scannedGenerations: 0,
		managedGenerations: 0,
		protectedGenerations: 0,
		quarantinedGenerations: 0,
		deletedGenerations: 0,
		deletedBytes: 0,
		deletedStaleLeases: 0,
	};
	const cacheDirectory = resolve(options.cacheDirectory);
	const trustedRoot = resolve(options.trustedRoot);
	if (
		!isAbsolute(options.cacheDirectory) ||
		cacheDirectory !== options.cacheDirectory ||
		!isAbsolute(options.trustedRoot) ||
		trustedRoot !== options.trustedRoot
	) {
		throw new Error("Helper cache cleanup paths must be absolute and normalized");
	}
	const maxGenerations = assertCleanupLimit(
		options.maxGenerations ?? DEFAULT_HELPER_CACHE_MAX_GENERATIONS,
		"Helper cache generation limit",
		true,
	);
	const maxScannedGenerations = assertCleanupLimit(
		options.maxScannedGenerations ?? DEFAULT_HELPER_CACHE_MAX_SCANNED_GENERATIONS,
		"Helper cache scan limit",
		false,
	);
	const maxDeletions = assertCleanupLimit(
		options.maxDeletions ?? DEFAULT_HELPER_CACHE_MAX_DELETIONS_PER_RUN,
		"Helper cache deletion limit",
		true,
	);
	const maxStaleLeaseDeletions = assertCleanupLimit(
		options.maxStaleLeaseDeletions ?? DEFAULT_HELPER_CACHE_MAX_STALE_LEASE_DELETIONS_PER_RUN,
		"Helper cache stale lease deletion limit",
		true,
	);
	const maxUnusedAgeMs = options.maxUnusedAgeMs ?? DEFAULT_HELPER_CACHE_MAX_UNUSED_AGE_MS;
	if (!Number.isFinite(maxUnusedAgeMs) || maxUnusedAgeMs < 0) {
		throw new TypeError("Helper cache maximum unused age must be a non-negative finite number");
	}
	const nowMs = options.nowMs ?? Date.now();
	if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError("Helper cache cleanup clock must be finite");
	const statusFor = options.testProcessInstanceStatus ?? getProcessInstanceStatus;
	const quarantined: Array<{ digest: string; path: string }> = [];

	try {
		ensureSecureExecutableCacheDirectory(cacheDirectory, trustedRoot);
	} catch {
		return result;
	}

	await withSecureFileLock(lockStatePath(cacheDirectory), async () => {
		ensureSecureExecutableCacheDirectory(cacheDirectory, trustedRoot);
		const trashDirectory = join(cacheDirectory, TRASH_DIRECTORY);
		ensureSecureExecutableCacheDirectory(trashDirectory, trustedRoot);
		const rootEntries = readdirSync(cacheDirectory, { withFileTypes: true });
		const generationEntries = rootEntries
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && DIGEST_PATTERN.test(entry.name))
			.map((entry) => {
				const path = join(cacheDirectory, entry.name);
				let mtimeMs = Number.POSITIVE_INFINITY;
				try {
					mtimeMs = lstatSync(path).mtimeMs;
				} catch {
					// A vanished entry is sorted last and skipped by inspection.
				}
				return { digest: entry.name, mtimeMs, path };
			})
			.sort((left, right) => left.mtimeMs - right.mtimeMs || left.digest.localeCompare(right.digest))
			.slice(0, maxScannedGenerations);
		const generations: ManagedGeneration[] = [];
		for (const entry of generationEntries) {
			result.scannedGenerations++;
			const generation = await inspectManagedGeneration(entry.path, entry.digest, statusFor);
			if (!generation) continue;
			result.managedGenerations++;
			if (generation.protected) result.protectedGenerations++;
			generations.push(generation);
		}

		let staleLeaseBudget = maxStaleLeaseDeletions;
		for (const generation of generations) {
			for (const lease of generation.leases) {
				if (staleLeaseBudget <= 0 || lease.status !== "dead") continue;
				if (await removeOwnedPathIfUnchanged(lease.path, lease.snapshot)) {
					staleLeaseBudget--;
					result.deletedStaleLeases++;
				}
			}
		}

		generations.sort(
			(left, right) => left.manifest.createdAt - right.manifest.createdAt || left.digest.localeCompare(right.digest),
		);
		let retained = generations.length;
		for (const generation of generations) {
			if (quarantined.length >= maxDeletions) break;
			if (generation.protected) continue;
			const expired = nowMs - generation.manifest.createdAt >= maxUnusedAgeMs;
			if (!expired && retained <= maxGenerations) continue;
			const final = await inspectManagedGeneration(generation.directoryPath, generation.digest, statusFor);
			if (!final || final.protected) continue;
			await options.testBeforeClaim?.(generation.directoryPath);
			const quarantinePath = join(trashDirectory, `${generation.digest}-${randomUUID().replaceAll("-", "")}`);
			try {
				await rename(generation.directoryPath, quarantinePath);
			} catch {
				continue;
			}
			const movedSnapshot = await snapshotOwnedPath(quarantinePath, "directory");
			const moved = await inspectManagedGeneration(quarantinePath, generation.digest, statusFor);
			if (
				!movedSnapshot ||
				!ownedPathSnapshotMatches(final.directorySnapshot, movedSnapshot) ||
				!moved ||
				moved.protected
			) {
				await restoreQuarantine(quarantinePath, generation.directoryPath);
				continue;
			}
			retained--;
			result.quarantinedGenerations++;
			quarantined.push({ digest: generation.digest, path: quarantinePath });
		}

		if (quarantined.length < maxDeletions) {
			let trashEntries: Dirent<string>[] = [];
			try {
				trashEntries = await readdir(trashDirectory, { withFileTypes: true });
			} catch {
				// The private trash directory was verified above; retain on any read error.
			}
			for (const entry of trashEntries) {
				if (quarantined.length >= maxDeletions) break;
				const match = QUARANTINE_PATTERN.exec(entry.name);
				if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
				const path = join(trashDirectory, entry.name);
				if (quarantined.some((candidate) => candidate.path === path)) continue;
				const generation = await inspectManagedGeneration(path, match[1], statusFor);
				if (!generation || generation.protected) continue;
				quarantined.push({ digest: match[1], path });
			}
		}
	});

	for (const candidate of quarantined) {
		const deletion = await deleteQuarantinedGeneration(candidate.path, candidate.digest, statusFor);
		if (!deletion.deleted) continue;
		result.deletedGenerations++;
		result.deletedBytes += deletion.bytes;
		// A concurrent materialization may have recreated the original path. The
		// prune keeps such a fresh index and drops only entries whose path vanished.
		pruneMissingRegisteredLeases(cacheDirectory);
	}
	return result;
}
