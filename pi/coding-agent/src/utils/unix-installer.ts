import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { secureAtomicWriteFile, secureFileExists, secureReadFile } from "@magenta/harness";
import {
	assertBinaryHelp,
	assertBinaryVersion,
	assertStagedBinaryStartup,
	buildVerificationEnvironment,
	extractReleaseResources,
	getBinaryAssetName,
	getUpdateTransactionResourceNames,
	lockInstallMutation,
	readBinaryVersion,
} from "./github-release-update.ts";
import {
	applyUnixUpdateTransaction,
	currentReleaseResourcesAreValid,
	InjectedUpdateInterruption,
	initializeReleaseUpdateTransaction,
	inspectReleaseResourceArchive,
	isManagedReleaseResourceName,
	LEGACY_MANAGED_RELEASE_RESOURCE_NAMES,
	parseReleaseChecksums,
	RELEASE_RESOURCE_MARKER_NAME,
	RELEASE_RESOURCES_ASSET_NAME,
	readInstalledReleaseOwnership,
	recoverInterruptedReleaseUpdateTransaction,
	validateExtractedReleaseResources,
	verifyReleaseArtifactChecksums,
	writeInstalledReleaseOwnership,
} from "./github-release-update-support.ts";
import { verifyMacosReleaseCandidate } from "./macos-release-verification.ts";

const operationIdPattern = /^[0-9a-f]{32}$/;
const releaseVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const UNIX_LAYOUT_JOURNAL_NAME = ".magenta-unix-layout-journal.json";
const UNIX_LAYOUT_JOURNAL_VERSION = 2;
const UNIX_LAYOUT_JOURNAL_MAX_BYTES = 64 * 1024;
const ENTRYPOINT_IDENTITY_KEYS = [
	"birthtimeNanoseconds",
	"device",
	"inode",
	"mode",
	"mtimeNanoseconds",
	"size",
] as const;

export interface InstallLocalUnixReleaseOptions {
	installDirectory: string;
	candidateBinary: string;
	resourceArchive: string;
	checksumsFile: string;
	binaryAssetName: string;
	expectedVersion: string;
	/** Optional PATH entry, managed as an atomic symlink to installDirectory/magenta. */
	entrypointPath?: string;
	/** Previous flat install root, used only for a proven legacy migration. */
	legacyInstallDirectory?: string;
	/** The executable that launched the hidden helper. Must identify candidateBinary exactly. */
	launchedExecutable: string;
	/** @internal Deterministic operation identity for tests. */
	operationId?: string;
	/** @internal Deterministic crash injection for native installer tests. */
	testFaultInjector?(point: string): void;
	/** @internal Injectable only for focused macOS verification tests. */
	verifyMacCandidate?(path: string): void;
}

export interface InstallLocalUnixReleaseResult {
	version: string;
	warnings: string[];
}

export interface UninstallLocalUnixReleaseOptions {
	installDirectory: string;
	entrypointPath?: string;
	legacyInstallDirectory?: string;
	/** @internal Deterministic interruption for focused uninstall tests. */
	testFaultInjector?(point: string): void;
}

export interface UninstallLocalUnixReleaseResult {
	removed: boolean;
	warnings: string[];
}

interface InstallationOwnership {
	binaryPresent: boolean;
	markerIsLegacy: boolean;
	markerVersion?: string;
	ownedResourceNames: string[];
}

interface EntrypointPlan {
	path: string;
	parentDirectory: string;
	state: "absent" | "active" | "legacy";
	observedIdentity?: EntrypointIdentity;
	legacyOwnership?: InstallationOwnership;
	legacyInstallDirectory?: string;
}

type EntrypointIdentity = {
	birthtimeNanoseconds: string;
	device: string;
	inode: string;
	mode: string;
	mtimeNanoseconds: string;
	size: string;
};

type UnixLayoutJournal = {
	version: typeof UNIX_LAYOUT_JOURNAL_VERSION;
	operationId: string;
	installDirectory: string;
	currentBinary: string;
	entrypointPath: string;
	legacyInstallDirectory: string;
	targetVersion: string;
	originalState: "absent" | "legacy";
	originalIdentity: EntrypointIdentity | null;
	temporaryPath: string;
	backupPath: string;
	phase: "prepared" | "payload_committed" | "entrypoint_activated";
};

function assertAbsoluteNormalizedPath(path: string, label: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) {
		throw new Error(`${label} must be an absolute normalized path`);
	}
}

function pathIsWithin(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function assertOwnedPath(path: string, type: "file" | "directory"): Promise<void> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || (type === "file" ? !stats.isFile() : !stats.isDirectory())) {
		throw new Error(
			`${type === "file" ? "File" : "Directory"} is missing, the wrong type, or symbolic-link backed: ${path}`,
		);
	}
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Path is not owned by the current user: ${path}`);
	}
}

async function ownedRegularFileExists(path: string): Promise<boolean> {
	try {
		await assertOwnedPath(path, "file");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function assertOwnedManagedPath(path: string): Promise<void> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
		throw new Error(`Managed Magenta path has an unsafe type or is symbolic-link backed: ${path}`);
	}
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Managed Magenta path is not owned by the current user: ${path}`);
	}
}

async function assertLegacyPackageIdentity(installDirectory: string): Promise<void> {
	const packagePath = join(installDirectory, "package.json");
	let manifest: unknown;
	try {
		await assertOwnedPath(packagePath, "file");
		manifest = JSON.parse(await readFile(packagePath, "utf8"));
	} catch {
		throw new Error("Legacy Magenta resources have no valid package identity; refusing ownership inference");
	}
	const piConfig =
		typeof manifest === "object" && manifest !== null && "piConfig" in manifest
			? (manifest as { piConfig?: unknown }).piConfig
			: undefined;
	if (
		typeof piConfig !== "object" ||
		piConfig === null ||
		(piConfig as { name?: unknown }).name !== "Magenta" ||
		(piConfig as { binaryName?: unknown }).binaryName !== "magenta" ||
		(piConfig as { configDir?: unknown }).configDir !== ".magenta"
	) {
		throw new Error("Legacy Magenta resources have no valid package identity; refusing ownership inference");
	}
}

function assertExistingBinaryIdentity(binaryPath: string, installDirectory: string): void {
	const result = spawnSync(binaryPath, ["--help"], {
		cwd: installDirectory,
		encoding: "utf8",
		env: buildVerificationEnvironment({ PI_PACKAGE_DIR: installDirectory }),
		maxBuffer: 4 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	const output = `${result.stdout}${result.stderr}`;
	if (result.status !== 0 || !/\bMagenta\b/i.test(output) || !/\bUsage:/i.test(output)) {
		throw new Error("Existing magenta binary does not expose the expected Magenta CLI identity");
	}
}

async function inspectInstallationOwnership(
	installDirectory: string,
	resourceNames: readonly string[],
	currentBinary?: string,
): Promise<InstallationOwnership> {
	const normalizedResourceNames = [...new Set(resourceNames)];
	if (normalizedResourceNames.some((name) => !isManagedReleaseResourceName(name))) {
		throw new Error("Installer ownership check received an unsafe resource name");
	}
	const markerPath = join(installDirectory, RELEASE_RESOURCE_MARKER_NAME);
	let marker: Awaited<ReturnType<typeof readInstalledReleaseOwnership>> | undefined;
	let markerError: unknown;
	if (await pathExists(markerPath)) {
		await assertOwnedManagedPath(markerPath);
		try {
			marker = await readInstalledReleaseOwnership(installDirectory);
		} catch (error) {
			markerError = error;
		}
	}
	const ownedResourceNames: string[] = [];
	for (const name of normalizedResourceNames) {
		const path = join(installDirectory, name);
		if (!(await pathExists(path))) continue;
		await assertOwnedManagedPath(path);
		ownedResourceNames.push(name);
	}

	const binaryPresent = currentBinary ? await ownedRegularFileExists(currentBinary) : false;
	let binaryVersion: string | undefined;
	if (binaryPresent && currentBinary) {
		binaryVersion = readBinaryVersion(currentBinary, installDirectory);
		if (!releaseVersionPattern.test(binaryVersion)) {
			throw new Error(`Existing magenta binary reported an invalid version: ${binaryVersion || "no output"}`);
		}
		assertBinaryHelp(currentBinary, installDirectory);
		assertExistingBinaryIdentity(currentBinary, installDirectory);
	}
	if (!marker && ownedResourceNames.length > 0) {
		if (!binaryPresent) {
			if (markerError) throw markerError;
			throw new Error(
				`Existing path cannot be proven as Magenta-owned; refusing replacement: ${ownedResourceNames[0]}`,
			);
		}
		await assertLegacyPackageIdentity(installDirectory);
	}
	if (marker?.resourceNames) {
		const ownershipNames = new Set(marker.resourceNames);
		const unownedName = ownedResourceNames.find((name) => !ownershipNames.has(name));
		if (unownedName) {
			throw new Error(`Existing path cannot be proven as Magenta-owned; refusing replacement: ${unownedName}`);
		}
	}
	if (!binaryPresent && marker && !marker.resourceNames) {
		await assertLegacyPackageIdentity(installDirectory);
	}
	return {
		binaryPresent,
		markerIsLegacy: Boolean(
			(marker && !marker.resourceNames) || (!marker && binaryPresent && ownedResourceNames.length > 0),
		),
		markerVersion: marker?.version ?? binaryVersion,
		ownedResourceNames,
	};
}

async function ensureDurableOwnershipMarker(installDirectory: string, ownership: InstallationOwnership): Promise<void> {
	if (!ownership.markerIsLegacy || !ownership.markerVersion) return;
	await writeInstalledReleaseOwnership(installDirectory, ownership.markerVersion, ownership.ownedResourceNames);
	ownership.markerIsLegacy = false;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function lstatEntrypoint(path: string): Promise<BigIntStats> {
	return lstat(path, { bigint: true });
}

function entrypointIdentity(stats: BigIntStats): EntrypointIdentity {
	return {
		birthtimeNanoseconds: String(stats.birthtimeNs),
		device: String(stats.dev),
		inode: String(stats.ino),
		mode: String(stats.mode),
		mtimeNanoseconds: String(stats.mtimeNs),
		size: String(stats.size),
	};
}

function identitiesMatch(left: EntrypointIdentity | undefined, right: EntrypointIdentity | null): boolean {
	return left !== undefined && right !== null && ENTRYPOINT_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function isOwnedByCurrentUser(stats: BigIntStats): boolean {
	return typeof process.getuid !== "function" || stats.uid === BigInt(process.getuid());
}

function layoutJournalPath(installDirectory: string): string {
	return join(installDirectory, UNIX_LAYOUT_JOURNAL_NAME);
}

function assertExactObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
		throw new Error(`${label} has an unexpected schema`);
	}
}

function parseLayoutJournal(content: string, installDirectory: string): UnixLayoutJournal {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Unix installer layout journal is corrupted");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Unix installer layout journal is corrupted");
	}
	const candidate = parsed as Record<string, unknown>;
	assertExactObjectKeys(
		candidate,
		[
			"backupPath",
			"currentBinary",
			"entrypointPath",
			"installDirectory",
			"legacyInstallDirectory",
			"operationId",
			"originalIdentity",
			"originalState",
			"phase",
			"targetVersion",
			"temporaryPath",
			"version",
		],
		"Unix installer layout journal",
	);
	if (candidate.version !== UNIX_LAYOUT_JOURNAL_VERSION) {
		throw new Error("Unix installer layout journal has an unsupported version");
	}
	for (const key of [
		"operationId",
		"installDirectory",
		"currentBinary",
		"entrypointPath",
		"legacyInstallDirectory",
		"targetVersion",
		"originalState",
		"temporaryPath",
		"backupPath",
		"phase",
	] as const) {
		if (typeof candidate[key] !== "string") throw new Error("Unix installer layout journal is corrupted");
	}
	const operationId = candidate.operationId as string;
	const entrypointPath = candidate.entrypointPath as string;
	const legacyInstallDirectory = candidate.legacyInstallDirectory as string;
	const originalState = candidate.originalState as string;
	const phase = candidate.phase as string;
	if (!operationIdPattern.test(operationId) || !releaseVersionPattern.test(candidate.targetVersion as string)) {
		throw new Error("Unix installer layout journal has invalid release identity");
	}
	if (
		candidate.installDirectory !== installDirectory ||
		candidate.currentBinary !== join(installDirectory, "magenta") ||
		!isAbsolute(entrypointPath) ||
		resolve(entrypointPath) !== entrypointPath ||
		basename(entrypointPath) !== "magenta" ||
		legacyInstallDirectory !== dirname(entrypointPath) ||
		candidate.temporaryPath !== join(legacyInstallDirectory, `.magenta-entrypoint-${operationId}`) ||
		candidate.backupPath !== join(legacyInstallDirectory, `.magenta-entrypoint-backup-${operationId}`)
	) {
		throw new Error("Unix installer layout journal contains paths outside its operation namespace");
	}
	if (!new Set(["absent", "legacy"]).has(originalState)) {
		throw new Error("Unix installer layout journal has an invalid original state");
	}
	if (!new Set(["prepared", "payload_committed", "entrypoint_activated"]).has(phase)) {
		throw new Error("Unix installer layout journal has an invalid phase");
	}
	let originalIdentity: EntrypointIdentity | null = null;
	if (candidate.originalIdentity !== null) {
		if (
			typeof candidate.originalIdentity !== "object" ||
			Array.isArray(candidate.originalIdentity) ||
			candidate.originalIdentity === null
		) {
			throw new Error("Unix installer layout journal has an invalid entrypoint identity");
		}
		const identity = candidate.originalIdentity as Record<string, unknown>;
		assertExactObjectKeys(identity, ENTRYPOINT_IDENTITY_KEYS, "Unix installer entrypoint identity");
		for (const key of ENTRYPOINT_IDENTITY_KEYS) {
			if (typeof identity[key] !== "string" || !/^\d+$/.test(identity[key])) {
				throw new Error("Unix installer layout journal has an invalid entrypoint identity");
			}
		}
		originalIdentity = {
			birthtimeNanoseconds: identity.birthtimeNanoseconds as string,
			device: identity.device as string,
			inode: identity.inode as string,
			mode: identity.mode as string,
			mtimeNanoseconds: identity.mtimeNanoseconds as string,
			size: identity.size as string,
		};
	}
	if ((originalState === "legacy") !== (originalIdentity !== null)) {
		throw new Error("Unix installer layout journal identity does not match its original state");
	}
	return {
		version: UNIX_LAYOUT_JOURNAL_VERSION,
		operationId,
		installDirectory,
		currentBinary: candidate.currentBinary as string,
		entrypointPath,
		legacyInstallDirectory,
		targetVersion: candidate.targetVersion as string,
		originalState: originalState as UnixLayoutJournal["originalState"],
		originalIdentity,
		temporaryPath: candidate.temporaryPath as string,
		backupPath: candidate.backupPath as string,
		phase: phase as UnixLayoutJournal["phase"],
	};
}

async function readLayoutJournal(installDirectory: string): Promise<UnixLayoutJournal | undefined> {
	const path = layoutJournalPath(installDirectory);
	if (!(await secureFileExists(path))) return undefined;
	return parseLayoutJournal(
		(await secureReadFile(path, { maxBytes: UNIX_LAYOUT_JOURNAL_MAX_BYTES })).toString("utf8"),
		installDirectory,
	);
}

async function writeLayoutJournal(journal: UnixLayoutJournal): Promise<void> {
	await secureAtomicWriteFile(layoutJournalPath(journal.installDirectory), `${JSON.stringify(journal)}\n`, {
		maxBytes: UNIX_LAYOUT_JOURNAL_MAX_BYTES,
	});
}

async function removeLayoutJournal(installDirectory: string): Promise<void> {
	const path = layoutJournalPath(installDirectory);
	if (!(await pathExists(path))) return;
	await assertOwnedPath(path, "file");
	await rm(path, { force: false });
	await syncDirectory(installDirectory);
}

async function removeOwnedEntrypointArtifact(path: string, assertIdentity?: EntrypointIdentity | null): Promise<void> {
	let stats: BigIntStats;
	try {
		stats = await lstatEntrypoint(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`Unix installer artifact unexpectedly became a symbolic link: ${path}`);
	}
	if (!stats.isFile() || !isOwnedByCurrentUser(stats)) {
		throw new Error(`Unix installer artifact has an unsafe identity: ${path}`);
	}
	if (assertIdentity && !identitiesMatch(entrypointIdentity(stats), assertIdentity)) {
		throw new Error(`Unix installer artifact changed identity: ${path}`);
	}
	await rm(path, { force: false });
}

async function pendingLayoutJournalParent(
	installDirectory: string,
	entrypointPath: string | undefined,
	legacyInstallDirectory: string | undefined,
): Promise<string | undefined> {
	const journal = await readLayoutJournal(installDirectory);
	if (!journal) return undefined;
	if (entrypointPath !== journal.entrypointPath || legacyInstallDirectory !== journal.legacyInstallDirectory) {
		throw new Error(
			`A pending Unix layout transaction belongs to ${journal.entrypointPath}; retry with the original entrypoint and legacy directory`,
		);
	}
	return journal.legacyInstallDirectory;
}

async function lockInstallDirectories(directories: Iterable<string>): Promise<Array<() => Promise<void>>> {
	const releases: Array<() => Promise<void>> = [];
	try {
		for (const directory of [...new Set(directories)].sort()) {
			releases.push(await lockInstallMutation(directory));
		}
		return releases;
	} catch (error) {
		for (const release of releases.reverse()) await release();
		throw error;
	}
}

async function canonicalDirectChildPath(path: string, label: string): Promise<{ parent: string; path: string }> {
	assertAbsoluteNormalizedPath(path, label);
	const parent = await realpath(dirname(path));
	if (parent !== dirname(path) || basename(path) !== "magenta") {
		throw new Error(`${label} must be a canonical path named magenta`);
	}
	await assertOwnedPath(parent, "directory");
	return { parent, path: join(parent, "magenta") };
}

async function hasLegacyOwnershipSignal(legacyInstallDirectory: string): Promise<boolean> {
	return (
		(await pathExists(join(legacyInstallDirectory, RELEASE_RESOURCE_MARKER_NAME))) ||
		(await pathExists(join(legacyInstallDirectory, "_magenta")))
	);
}

async function prepareEntrypointPlan(
	entrypointPath: string,
	currentBinary: string,
	legacyInstallDirectory: string | undefined,
	resourceNames: readonly string[],
): Promise<EntrypointPlan> {
	const entrypoint = await canonicalDirectChildPath(entrypointPath, "Entrypoint path");
	let legacyDirectory: string | undefined;
	if (legacyInstallDirectory) {
		assertAbsoluteNormalizedPath(legacyInstallDirectory, "Legacy install directory");
		legacyDirectory = await realpath(legacyInstallDirectory);
		if (legacyDirectory !== legacyInstallDirectory || legacyDirectory !== entrypoint.parent) {
			throw new Error("Legacy install directory must be the canonical entrypoint directory");
		}
		await assertOwnedPath(legacyDirectory, "directory");
	}

	let stats: BigIntStats | undefined;
	try {
		stats = await lstatEntrypoint(entrypoint.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (stats?.isSymbolicLink()) {
		const target = resolve(entrypoint.parent, await readlink(entrypoint.path));
		if (target !== currentBinary)
			throw new Error(`Entrypoint symbolic link is not owned by this installation: ${entrypoint.path}`);
		const legacyOwnership =
			legacyDirectory && (await hasLegacyOwnershipSignal(legacyDirectory))
				? await inspectInstallationOwnership(legacyDirectory, resourceNames)
				: undefined;
		return {
			path: entrypoint.path,
			parentDirectory: entrypoint.parent,
			state: "active",
			observedIdentity: entrypointIdentity(stats),
			legacyInstallDirectory: legacyDirectory,
			legacyOwnership,
		};
	}
	if (stats) {
		if (!stats.isFile() || !isOwnedByCurrentUser(stats)) {
			throw new Error(`Entrypoint is not a user-owned regular file: ${entrypoint.path}`);
		}
		if (!legacyDirectory)
			throw new Error(`Entrypoint already exists and is not managed by Magenta: ${entrypoint.path}`);
		const legacyOwnership = await inspectInstallationOwnership(legacyDirectory, resourceNames, entrypoint.path);
		return {
			path: entrypoint.path,
			parentDirectory: entrypoint.parent,
			state: "legacy",
			observedIdentity: entrypointIdentity(stats),
			legacyInstallDirectory: legacyDirectory,
			legacyOwnership,
		};
	}
	const legacyOwnership =
		legacyDirectory && (await hasLegacyOwnershipSignal(legacyDirectory))
			? await inspectInstallationOwnership(legacyDirectory, resourceNames)
			: undefined;
	return {
		path: entrypoint.path,
		parentDirectory: entrypoint.parent,
		state: "absent",
		legacyInstallDirectory: legacyDirectory,
		legacyOwnership,
	};
}

async function assertEntrypointPlanUnchanged(plan: EntrypointPlan, currentBinary: string): Promise<void> {
	let stats: BigIntStats | undefined;
	try {
		stats = await lstatEntrypoint(plan.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (plan.state === "absent") {
		if (stats) throw new Error(`Entrypoint changed after installer preflight: ${plan.path}`);
		return;
	}
	if (!stats || !plan.observedIdentity) {
		throw new Error(`Entrypoint changed after installer preflight: ${plan.path}`);
	}
	if (!identitiesMatch(entrypointIdentity(stats), plan.observedIdentity)) {
		throw new Error(`Entrypoint changed after installer preflight: ${plan.path}`);
	}
	if (plan.state === "active") {
		if (!stats.isSymbolicLink() || resolve(plan.parentDirectory, await readlink(plan.path)) !== currentBinary) {
			throw new Error(`Entrypoint changed after installer preflight: ${plan.path}`);
		}
		return;
	}
	if (!stats.isFile() || !isOwnedByCurrentUser(stats)) {
		throw new Error(`Entrypoint changed after installer preflight: ${plan.path}`);
	}
}

async function removeOwnedOperationDirectory(path: string): Promise<void> {
	try {
		await assertOwnedPath(path, "directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await rm(path, { recursive: true, force: false });
}

async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

type ObservedEntrypointState = "absent" | "original" | "target";

async function observeJournalEntrypoint(journal: UnixLayoutJournal): Promise<ObservedEntrypointState> {
	let stats: BigIntStats;
	try {
		stats = await lstatEntrypoint(journal.entrypointPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
	if (stats.isSymbolicLink()) {
		if (resolve(journal.legacyInstallDirectory, await readlink(journal.entrypointPath)) === journal.currentBinary) {
			return "target";
		}
		throw new Error(`Pending Unix entrypoint was replaced by an unowned symbolic link: ${journal.entrypointPath}`);
	}
	if (
		journal.originalState === "legacy" &&
		stats.isFile() &&
		isOwnedByCurrentUser(stats) &&
		identitiesMatch(entrypointIdentity(stats), journal.originalIdentity)
	) {
		return "original";
	}
	throw new Error(`Pending Unix entrypoint changed outside its recorded transaction: ${journal.entrypointPath}`);
}

async function validateLayoutArtifactSymlink(path: string, currentBinary: string): Promise<boolean> {
	let stats: Awaited<ReturnType<typeof lstat>>;
	try {
		stats = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (!stats.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== currentBinary) {
		throw new Error(`Unix entrypoint staging path changed identity: ${path}`);
	}
	return true;
}

async function validateLayoutBackup(journal: UnixLayoutJournal): Promise<boolean> {
	let stats: BigIntStats;
	try {
		stats = await lstatEntrypoint(journal.backupPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (
		journal.originalState !== "legacy" ||
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		!isOwnedByCurrentUser(stats) ||
		!identitiesMatch(entrypointIdentity(stats), journal.originalIdentity)
	) {
		throw new Error(`Unix entrypoint backup changed identity: ${journal.backupPath}`);
	}
	return true;
}

async function layoutPayloadIsValid(journal: UnixLayoutJournal): Promise<boolean> {
	if (!(await ownedRegularFileExists(journal.currentBinary))) return false;
	try {
		assertBinaryVersion(journal.currentBinary, journal.targetVersion, journal.installDirectory);
		assertBinaryHelp(journal.currentBinary, journal.installDirectory);
		return currentReleaseResourcesAreValid(journal.installDirectory, journal.targetVersion);
	} catch {
		return false;
	}
}

async function recoverInterruptedEntrypointActivation(
	installDirectory: string,
	options: { finishValidPayload?: boolean } = {},
): Promise<boolean> {
	const journal = await readLayoutJournal(installDirectory);
	if (!journal) return false;
	const canonicalEntrypoint = await canonicalDirectChildPath(journal.entrypointPath, "Journal entrypoint path");
	if (canonicalEntrypoint.parent !== journal.legacyInstallDirectory) {
		throw new Error("Unix installer layout journal parent is no longer canonical");
	}
	const state = await observeJournalEntrypoint(journal);
	const hasTemporary = await validateLayoutArtifactSymlink(journal.temporaryPath, journal.currentBinary);
	const hasBackup = await validateLayoutBackup(journal);
	const payloadValid = options.finishValidPayload === false ? false : await layoutPayloadIsValid(journal);

	if (!payloadValid) {
		if (state === "target") {
			if (journal.originalState === "legacy") {
				if (!hasBackup) throw new Error("Cannot restore the original Unix entrypoint; its backup is missing");
				await rename(journal.backupPath, journal.entrypointPath);
				await syncDirectory(journal.legacyInstallDirectory);
			} else {
				await rm(journal.entrypointPath, { force: false });
				await syncDirectory(journal.legacyInstallDirectory);
			}
		} else if (state === "absent" && journal.originalState === "legacy") {
			if (!hasBackup) throw new Error("Cannot restore the original Unix entrypoint; its backup is missing");
			await rename(journal.backupPath, journal.entrypointPath);
			await syncDirectory(journal.legacyInstallDirectory);
		} else if (state === "original" && hasBackup) {
			await removeOwnedEntrypointArtifact(journal.backupPath, journal.originalIdentity);
			await syncDirectory(journal.legacyInstallDirectory);
		}
		if (hasTemporary) {
			await rm(journal.temporaryPath, { force: false });
			await syncDirectory(journal.legacyInstallDirectory);
		}
		await removeLayoutJournal(installDirectory);
		return true;
	}

	if (state !== "target") {
		if (journal.originalState === "absent") {
			if (state !== "absent") throw new Error("Fresh Unix entrypoint activation has an invalid original state");
			if (hasTemporary) await rm(journal.temporaryPath, { force: false });
			await symlink(journal.currentBinary, journal.entrypointPath);
		} else {
			if (state === "original" && !hasBackup) {
				await link(journal.entrypointPath, journal.backupPath);
				await syncFile(journal.backupPath);
				await syncDirectory(journal.legacyInstallDirectory);
			}
			if (state === "absent" && !hasBackup) {
				throw new Error("Cannot finish Unix entrypoint activation; the original entrypoint backup is missing");
			}
			if (!hasTemporary) await symlink(journal.currentBinary, journal.temporaryPath);
			await rename(journal.temporaryPath, journal.entrypointPath);
		}
		await syncDirectory(journal.legacyInstallDirectory);
	}
	const activatedStats = await lstat(journal.entrypointPath);
	if (!activatedStats.isSymbolicLink() || (await realpath(journal.entrypointPath)) !== journal.currentBinary) {
		throw new Error("Recovered Unix entrypoint does not resolve to the verified Magenta binary");
	}
	await writeLayoutJournal({ ...journal, phase: "entrypoint_activated" });
	if (await validateLayoutBackup(journal)) {
		await removeOwnedEntrypointArtifact(journal.backupPath, journal.originalIdentity);
		await syncDirectory(journal.legacyInstallDirectory);
	}
	if (await validateLayoutArtifactSymlink(journal.temporaryPath, journal.currentBinary)) {
		await rm(journal.temporaryPath, { force: false });
		await syncDirectory(journal.legacyInstallDirectory);
	}
	await removeLayoutJournal(installDirectory);
	return true;
}

function createLayoutJournal(
	plan: EntrypointPlan,
	installDirectory: string,
	currentBinary: string,
	targetVersion: string,
	operationId: string,
): UnixLayoutJournal | undefined {
	if (plan.state === "active") return undefined;
	if (!plan.legacyInstallDirectory || plan.legacyInstallDirectory !== plan.parentDirectory) {
		throw new Error("Unix entrypoint activation requires its canonical legacy directory");
	}
	const originalIdentity = plan.observedIdentity ?? null;
	if ((plan.state === "legacy") !== (originalIdentity !== null)) {
		throw new Error("Unix entrypoint preflight identity does not match its state");
	}
	return {
		version: UNIX_LAYOUT_JOURNAL_VERSION,
		operationId,
		installDirectory,
		currentBinary,
		entrypointPath: plan.path,
		legacyInstallDirectory: plan.parentDirectory,
		targetVersion,
		originalState: plan.state,
		originalIdentity,
		temporaryPath: join(plan.parentDirectory, `.magenta-entrypoint-${operationId}`),
		backupPath: join(plan.parentDirectory, `.magenta-entrypoint-backup-${operationId}`),
		phase: "prepared",
	};
}

async function activateEntrypoint(
	plan: EntrypointPlan,
	currentBinary: string,
	journal: UnixLayoutJournal | undefined,
	testFaultInjector?: (point: string) => void,
): Promise<boolean> {
	if (plan.state === "active") {
		await assertEntrypointPlanUnchanged(plan, currentBinary);
		if ((await realpath(plan.path)) !== currentBinary) {
			throw new Error("Installed Magenta entrypoint does not resolve to the verified binary");
		}
		return false;
	}
	if (!journal) throw new Error("Unix entrypoint activation is missing its durable layout journal");
	const temporaryPath = journal.temporaryPath;
	if (await pathExists(temporaryPath)) throw new Error(`Entrypoint staging path already exists: ${temporaryPath}`);
	await symlink(currentBinary, temporaryPath);
	let operationError: unknown;
	try {
		testFaultInjector?.("entrypoint:prepared");
		await assertEntrypointPlanUnchanged(plan, currentBinary);
		if (plan.state === "legacy") {
			if (await pathExists(journal.backupPath)) {
				throw new Error(`Entrypoint backup path already exists: ${journal.backupPath}`);
			}
			await link(plan.path, journal.backupPath);
			await syncFile(journal.backupPath);
			await syncDirectory(plan.parentDirectory);
			await assertEntrypointPlanUnchanged(plan, currentBinary);
			await rename(temporaryPath, plan.path);
		} else {
			await rm(temporaryPath, { force: false });
			await symlink(currentBinary, plan.path);
		}
		await syncDirectory(plan.parentDirectory);
		testFaultInjector?.("entrypoint:activated");
	} catch (error) {
		operationError = error;
	}
	if (await pathExists(temporaryPath)) {
		const stats = await lstat(temporaryPath);
		if (!stats.isSymbolicLink() || resolve(plan.parentDirectory, await readlink(temporaryPath)) !== currentBinary) {
			throw new Error(`Entrypoint staging path changed identity: ${temporaryPath}`);
		}
		await rm(temporaryPath, { force: false });
	}
	if (operationError) throw operationError;
	const stats = await lstat(plan.path);
	if (!stats.isSymbolicLink() || (await realpath(plan.path)) !== currentBinary) {
		throw new Error("Installed Magenta entrypoint does not resolve to the verified binary");
	}
	return true;
}

async function cleanupLegacyResources(
	plan: EntrypointPlan,
	testFaultInjector?: (point: string) => void,
): Promise<void> {
	const legacyDirectory = plan.legacyInstallDirectory;
	const ownership = plan.legacyOwnership;
	if (!legacyDirectory || !ownership) return;
	await ensureDurableOwnershipMarker(legacyDirectory, ownership);
	const markerLast = ownership.ownedResourceNames.filter((name) => name !== RELEASE_RESOURCE_MARKER_NAME);
	if (ownership.ownedResourceNames.includes(RELEASE_RESOURCE_MARKER_NAME))
		markerLast.push(RELEASE_RESOURCE_MARKER_NAME);
	for (const name of markerLast) {
		const path = join(legacyDirectory, name);
		if (!(await pathExists(path))) continue;
		await assertOwnedManagedPath(path);
		await rm(path, { recursive: true, force: false });
		await syncDirectory(legacyDirectory);
		testFaultInjector?.(`legacy-cleanup:${name}`);
	}
}

export async function installLocalUnixRelease(
	options: InstallLocalUnixReleaseOptions,
): Promise<InstallLocalUnixReleaseResult> {
	if (process.platform === "win32") throw new Error("The Unix installer helper is not available on Windows");
	for (const [path, label] of [
		[options.installDirectory, "Install directory"],
		[options.candidateBinary, "Candidate binary"],
		[options.resourceArchive, "Resource archive"],
		[options.checksumsFile, "Checksum manifest"],
		[options.launchedExecutable, "Launched executable"],
	] as const) {
		assertAbsoluteNormalizedPath(path, label);
	}
	if (options.entrypointPath) assertAbsoluteNormalizedPath(options.entrypointPath, "Entrypoint path");
	if (options.legacyInstallDirectory) {
		assertAbsoluteNormalizedPath(options.legacyInstallDirectory, "Legacy install directory");
	}
	await assertOwnedPath(options.installDirectory, "directory");
	await assertOwnedPath(options.candidateBinary, "file");
	await assertOwnedPath(options.resourceArchive, "file");
	await assertOwnedPath(options.checksumsFile, "file");
	await assertOwnedPath(options.launchedExecutable, "file");
	const installDirectory = await realpath(options.installDirectory);
	if (installDirectory !== options.installDirectory || dirname(installDirectory) === installDirectory) {
		throw new Error("Install directory must be a canonical directory below the filesystem root");
	}
	const candidateBinary = await realpath(options.candidateBinary);
	const resourceArchive = await realpath(options.resourceArchive);
	const checksumsFile = await realpath(options.checksumsFile);
	const launchedExecutable = await realpath(options.launchedExecutable);
	await assertOwnedPath(installDirectory, "directory");
	await assertOwnedPath(candidateBinary, "file");
	await assertOwnedPath(resourceArchive, "file");
	await assertOwnedPath(checksumsFile, "file");
	await assertOwnedPath(launchedExecutable, "file");
	if (candidateBinary !== launchedExecutable) {
		throw new Error("Installer candidate does not match the executable that launched the helper");
	}
	for (const [path, label] of [
		[candidateBinary, "Candidate binary"],
		[resourceArchive, "Resource archive"],
		[checksumsFile, "Checksum manifest"],
	] as const) {
		if (pathIsWithin(installDirectory, path)) throw new Error(`${label} must be outside the installation directory`);
	}
	if (!releaseVersionPattern.test(options.expectedVersion)) {
		throw new Error(`Expected version is not an exact release version: ${options.expectedVersion}`);
	}

	const expectedBinaryAssetName = getBinaryAssetName();
	if (options.binaryAssetName !== expectedBinaryAssetName) {
		throw new Error(`Installer binary asset does not match this platform: ${options.binaryAssetName}`);
	}
	const checksums = parseReleaseChecksums(await readFile(checksumsFile, "utf8"));
	await verifyReleaseArtifactChecksums(checksums, [
		{ name: options.binaryAssetName, path: candidateBinary },
		{ name: RELEASE_RESOURCES_ASSET_NAME, path: resourceArchive },
	]);
	if (process.platform === "darwin") {
		(options.verifyMacCandidate ?? verifyMacosReleaseCandidate)(candidateBinary);
	}
	const targetVersion = readBinaryVersion(candidateBinary, dirname(candidateBinary));
	if (!releaseVersionPattern.test(targetVersion)) {
		throw new Error(`Candidate binary reported an invalid release version: ${targetVersion || "no output"}`);
	}
	if (targetVersion !== options.expectedVersion) {
		throw new Error(`Candidate binary version ${targetVersion} does not match expected ${options.expectedVersion}`);
	}
	const operationId = options.operationId ?? randomUUID().replaceAll("-", "");
	if (!operationIdPattern.test(operationId)) throw new Error("Installer operation id is invalid");

	const currentBinary = join(installDirectory, "magenta");
	if (options.entrypointPath === currentBinary) {
		throw new Error("Entrypoint path must be outside the self-contained installation directory");
	}
	const stagingDirectory = join(installDirectory, `.magenta-update-staging-${operationId}`);
	const backupDirectory = join(installDirectory, `.magenta-update-backup-${operationId}`);
	const stagedBinary = join(stagingDirectory, basename(currentBinary));
	const stagedResourceArchive = join(stagingDirectory, ".magenta-resources-universal.tar.gz");
	const lockDirectories = new Set([installDirectory]);
	if (options.entrypointPath) {
		const entrypoint = await canonicalDirectChildPath(options.entrypointPath, "Entrypoint path");
		lockDirectories.add(entrypoint.parent);
	}
	if (options.legacyInstallDirectory) {
		const legacyDirectory = await realpath(options.legacyInstallDirectory);
		if (legacyDirectory !== options.legacyInstallDirectory) {
			throw new Error("Legacy install directory must be canonical");
		}
		await assertOwnedPath(legacyDirectory, "directory");
		lockDirectories.add(legacyDirectory);
	}
	const pendingEntrypointParent = await pendingLayoutJournalParent(
		installDirectory,
		options.entrypointPath,
		options.legacyInstallDirectory,
	);
	if (pendingEntrypointParent) lockDirectories.add(pendingEntrypointParent);
	const releaseLocks = await lockInstallDirectories(lockDirectories);
	let preserveInterruptedTransaction = false;
	let stagingCreated = false;
	let journalOwned = false;
	let layoutJournal: UnixLayoutJournal | undefined;
	let payloadCommitted = false;
	try {
		await recoverInterruptedReleaseUpdateTransaction(installDirectory);
		if (options.legacyInstallDirectory && options.legacyInstallDirectory !== installDirectory) {
			await recoverInterruptedReleaseUpdateTransaction(options.legacyInstallDirectory);
		}
		await recoverInterruptedEntrypointActivation(installDirectory);
		await mkdir(stagingDirectory, { mode: 0o700 });
		stagingCreated = true;
		options.testFaultInjector?.("snapshot:before-copy");
		await copyFile(resourceArchive, stagedResourceArchive);
		await copyFile(candidateBinary, stagedBinary);
		await chmod(stagedBinary, 0o755);
		await verifyReleaseArtifactChecksums(checksums, [
			{ name: options.binaryAssetName, path: stagedBinary },
			{ name: RELEASE_RESOURCES_ASSET_NAME, path: stagedResourceArchive },
		]);
		const archiveResourceNames = await inspectReleaseResourceArchive(stagedResourceArchive);
		const resourceNames = getUpdateTransactionResourceNames(archiveResourceNames);
		options.testFaultInjector?.("snapshot:complete");

		const installationOwnership = await inspectInstallationOwnership(installDirectory, resourceNames, currentBinary);
		const originalBinaryPresent = installationOwnership.binaryPresent;
		const entrypointPlan = options.entrypointPath
			? await prepareEntrypointPlan(
					options.entrypointPath,
					currentBinary,
					options.legacyInstallDirectory,
					resourceNames,
				)
			: undefined;
		if (entrypointPlan) {
			layoutJournal = createLayoutJournal(
				entrypointPlan,
				installDirectory,
				currentBinary,
				targetVersion,
				operationId,
			);
			if (layoutJournal) {
				if (await secureFileExists(layoutJournalPath(installDirectory))) {
					throw new Error("A Unix installer layout transaction is already pending");
				}
				await writeLayoutJournal(layoutJournal);
			}
		}

		await initializeReleaseUpdateTransaction({
			installDirectory,
			operationId,
			kind: "unix",
			binaryName: basename(currentBinary),
			originalBinaryPresent,
			targetVersion,
		});
		journalOwned = true;
		extractReleaseResources(stagedResourceArchive, stagingDirectory);
		await rm(stagedResourceArchive, { force: false });
		await syncDirectory(stagingDirectory);
		await validateExtractedReleaseResources(stagingDirectory, archiveResourceNames, targetVersion);
		assertBinaryVersion(stagedBinary, targetVersion, stagingDirectory);
		assertBinaryHelp(stagedBinary, stagingDirectory);
		assertStagedBinaryStartup(stagedBinary, stagingDirectory);

		const warnings = await applyUnixUpdateTransaction({
			currentBinary,
			originalBinaryPresent,
			operationId,
			stagingDirectory,
			backupDirectory,
			resourceNames,
			targetVersion,
			verifyInstalled: async () => {
				assertBinaryVersion(currentBinary, targetVersion, installDirectory);
				assertBinaryHelp(currentBinary, installDirectory);
				if (!(await currentReleaseResourcesAreValid(installDirectory, targetVersion))) {
					throw new Error("Installed runtime resources are incomplete or version-mismatched");
				}
			},
			testFaultInjector: options.testFaultInjector,
		});
		payloadCommitted = true;
		if (layoutJournal) {
			layoutJournal = { ...layoutJournal, phase: "payload_committed" };
			await writeLayoutJournal(layoutJournal);
		}
		if (entrypointPlan) {
			await activateEntrypoint(entrypointPlan, currentBinary, layoutJournal, options.testFaultInjector);
			if (layoutJournal) {
				layoutJournal = { ...layoutJournal, phase: "entrypoint_activated" };
				await writeLayoutJournal(layoutJournal);
			}
			try {
				await cleanupLegacyResources(entrypointPlan, options.testFaultInjector);
			} catch (error) {
				warnings.push(
					`Verified legacy installation cleanup was deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (layoutJournal) {
				if (await validateLayoutBackup(layoutJournal)) {
					await removeOwnedEntrypointArtifact(layoutJournal.backupPath, layoutJournal.originalIdentity);
					await syncDirectory(layoutJournal.legacyInstallDirectory);
				}
				if (await validateLayoutArtifactSymlink(layoutJournal.temporaryPath, currentBinary)) {
					await rm(layoutJournal.temporaryPath, { force: false });
					await syncDirectory(layoutJournal.legacyInstallDirectory);
				}
				await removeLayoutJournal(installDirectory);
				layoutJournal = undefined;
			}
		}
		return { version: targetVersion, warnings };
	} catch (error) {
		if (error instanceof InjectedUpdateInterruption) {
			preserveInterruptedTransaction = true;
			throw error;
		}
		try {
			await recoverInterruptedReleaseUpdateTransaction(installDirectory);
			if (layoutJournal && !payloadCommitted) {
				await recoverInterruptedEntrypointActivation(installDirectory, { finishValidPayload: false });
				layoutJournal = undefined;
			}
		} catch (recoveryError) {
			preserveInterruptedTransaction = true;
			throw new Error(
				`Unix installation failed (${error instanceof Error ? error.message : String(error)}) and recovery was incomplete; transaction state was preserved: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
			);
		}
		if (layoutJournal && payloadCommitted) {
			throw new Error(
				`Unix payload ${targetVersion} was committed, but entrypoint activation is pending durable recovery: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		throw error;
	} finally {
		if (stagingCreated && !journalOwned && !preserveInterruptedTransaction) {
			await removeOwnedOperationDirectory(stagingDirectory);
		}
		for (const release of releaseLocks.reverse()) await release();
	}
}

async function uninstallResourceNames(installDirectory: string): Promise<string[]> {
	try {
		const marker = await readInstalledReleaseOwnership(installDirectory);
		return [...new Set([...(marker.resourceNames ?? LEGACY_MANAGED_RELEASE_RESOURCE_NAMES)])];
	} catch {
		return [...LEGACY_MANAGED_RELEASE_RESOURCE_NAMES];
	}
}

async function removeOwnedInstallationPayload(
	installDirectory: string,
	currentBinary: string,
	ownership: InstallationOwnership,
	label: "install" | "legacy",
	testFaultInjector?: (point: string) => void,
): Promise<boolean> {
	let removed = false;
	if (ownership.binaryPresent) {
		await assertOwnedPath(currentBinary, "file");
		await rm(currentBinary, { force: false });
		await syncDirectory(installDirectory);
		removed = true;
		testFaultInjector?.(`uninstall:${label}:binary`);
	}
	const markerLast = ownership.ownedResourceNames.filter((name) => name !== RELEASE_RESOURCE_MARKER_NAME);
	if (ownership.ownedResourceNames.includes(RELEASE_RESOURCE_MARKER_NAME))
		markerLast.push(RELEASE_RESOURCE_MARKER_NAME);
	for (const name of markerLast) {
		const path = join(installDirectory, name);
		if (!(await pathExists(path))) continue;
		await assertOwnedManagedPath(path);
		await rm(path, { recursive: true, force: false });
		await syncDirectory(installDirectory);
		removed = true;
		testFaultInjector?.(`uninstall:${label}:${name}`);
	}
	return removed;
}

export async function uninstallLocalUnixRelease(
	options: UninstallLocalUnixReleaseOptions,
): Promise<UninstallLocalUnixReleaseResult> {
	if (process.platform === "win32") throw new Error("The Unix uninstaller helper is not available on Windows");
	assertAbsoluteNormalizedPath(options.installDirectory, "Install directory");
	if (options.entrypointPath) assertAbsoluteNormalizedPath(options.entrypointPath, "Entrypoint path");
	if (options.legacyInstallDirectory) {
		assertAbsoluteNormalizedPath(options.legacyInstallDirectory, "Legacy install directory");
	}
	await assertOwnedPath(options.installDirectory, "directory");
	const installDirectory = await realpath(options.installDirectory);
	if (installDirectory !== options.installDirectory || dirname(installDirectory) === installDirectory) {
		throw new Error("Install directory must be a canonical directory below the filesystem root");
	}
	const currentBinary = join(installDirectory, "magenta");
	if (options.entrypointPath === currentBinary) {
		throw new Error("Entrypoint path must be outside the self-contained installation directory");
	}

	const lockDirectories = new Set([installDirectory]);
	if (options.entrypointPath) {
		const entrypoint = await canonicalDirectChildPath(options.entrypointPath, "Entrypoint path");
		lockDirectories.add(entrypoint.parent);
	}
	if (options.legacyInstallDirectory) {
		const legacyDirectory = await realpath(options.legacyInstallDirectory);
		if (legacyDirectory !== options.legacyInstallDirectory) {
			throw new Error("Legacy install directory must be canonical");
		}
		await assertOwnedPath(legacyDirectory, "directory");
		lockDirectories.add(legacyDirectory);
	}
	const pendingEntrypointParent = await pendingLayoutJournalParent(
		installDirectory,
		options.entrypointPath,
		options.legacyInstallDirectory,
	);
	if (pendingEntrypointParent) lockDirectories.add(pendingEntrypointParent);
	const releases = await lockInstallDirectories(lockDirectories);
	let removed = false;
	const warnings: string[] = [];
	try {
		await recoverInterruptedReleaseUpdateTransaction(installDirectory);
		if (options.legacyInstallDirectory && options.legacyInstallDirectory !== installDirectory) {
			await recoverInterruptedReleaseUpdateTransaction(options.legacyInstallDirectory);
		}
		await recoverInterruptedEntrypointActivation(installDirectory);
		const targetResourceNames = await uninstallResourceNames(installDirectory);
		const targetOwnership = await inspectInstallationOwnership(installDirectory, targetResourceNames, currentBinary);
		let entrypointPlan: EntrypointPlan | undefined;
		if (options.entrypointPath) {
			const legacyResourceNames = options.legacyInstallDirectory
				? await uninstallResourceNames(options.legacyInstallDirectory)
				: [...LEGACY_MANAGED_RELEASE_RESOURCE_NAMES];
			entrypointPlan = await prepareEntrypointPlan(
				options.entrypointPath,
				currentBinary,
				options.legacyInstallDirectory,
				legacyResourceNames,
			);
		}

		await ensureDurableOwnershipMarker(installDirectory, targetOwnership);
		if (entrypointPlan?.legacyInstallDirectory && entrypointPlan.legacyOwnership) {
			await ensureDurableOwnershipMarker(entrypointPlan.legacyInstallDirectory, entrypointPlan.legacyOwnership);
		}
		if (entrypointPlan?.state === "active") {
			const stats = await lstat(entrypointPlan.path);
			const target = stats.isSymbolicLink()
				? resolve(entrypointPlan.parentDirectory, await readlink(entrypointPlan.path))
				: undefined;
			if (target !== currentBinary) throw new Error("Magenta entrypoint changed during uninstall preflight");
			await rm(entrypointPlan.path, { force: false });
			await syncDirectory(entrypointPlan.parentDirectory);
			removed = true;
			options.testFaultInjector?.("uninstall:entrypoint");
		}
		removed =
			(await removeOwnedInstallationPayload(
				installDirectory,
				currentBinary,
				targetOwnership,
				"install",
				options.testFaultInjector,
			)) || removed;
		if (entrypointPlan?.legacyInstallDirectory && entrypointPlan.legacyOwnership) {
			removed =
				(await removeOwnedInstallationPayload(
					entrypointPlan.legacyInstallDirectory,
					entrypointPlan.path,
					entrypointPlan.legacyOwnership,
					"legacy",
					options.testFaultInjector,
				)) || removed;
		}
	} finally {
		for (const release of releases.reverse()) await release();
	}
	if (options.entrypointPath) {
		try {
			await rmdir(installDirectory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
				warnings.push(`Could not remove the empty installation directory: ${String(error)}`);
			}
		}
	}
	return { removed, warnings };
}
