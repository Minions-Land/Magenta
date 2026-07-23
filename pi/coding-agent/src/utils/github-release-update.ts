/**
 * GitHub Releases-based auto-update mechanism for Magenta.
 *
 * This module checks GitHub Releases for new versions and downloads the binary
 * when updates are available. Binaries are published to a PUBLIC repository
 * (Minions-Land/Magenta-CLI) so downloads work anonymously with no token.
 *
 * Unlike magenta-update.ts (git-based), this works with distributed binaries.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { secureAtomicWriteFile, secureReadFile } from "@magenta/harness";
import lockfile from "proper-lockfile";
import { ENV_AGENT_DIR, ENV_PEER_MESSAGE_DB, getConfigRootDir, isBunBinary, VERSION } from "../config.ts";
import { resolveGitHubUrl } from "./github-mirror.ts";
import {
	applyResourceUpdateTransaction,
	applyUnixUpdateTransaction,
	bindWindowsReleaseUpdateHelper,
	buildWindowsUpdateScript,
	calculateFileSha256,
	currentReleaseResourcesAreValid,
	getWindowsReleaseUpdateProcessStartTimeUtc,
	initializeReleaseUpdateTransaction,
	inspectReleaseResourceArchive,
	parseReleaseChecksums,
	prepareWindowsReleaseUpdateTransaction,
	RELEASE_CHECKSUMS_ASSET_NAME,
	RELEASE_INSTALL_LOCK_NAME,
	RELEASE_RESOURCE_MARKER_NAME,
	RELEASE_RESOURCES_ASSET_NAME,
	type ReleaseAssetPlan,
	readInstalledReleaseOwnership,
	recoverInterruptedReleaseUpdateTransaction,
	resolveReleaseAssetPlan,
	shouldUseMirrorForReleaseAsset,
	validateExtractedReleaseResources,
	verifyReleaseArtifactChecksums,
	verifyReleaseAssetDigest,
} from "./github-release-update-support.ts";
import { verifyMacosReleaseCandidate } from "./macos-release-verification.ts";

const GITHUB_REPO = process.env.MAGENTA_GITHUB_REPO || "Minions-Land/Magenta-CLI";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const ARCHIVE_EXTRACTION_TIMEOUT_MS = 300_000;
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes of no data = stalled
const DOWNLOAD_WALL_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_MAX_RETRIES = 3;
const INSTALL_LOCK_STALE_MS = 15 * 60_000;
const BINARY_VERIFICATION_TIMEOUT_MS = 30_000;
const UPDATE_CHECK_STATE_MAX_BYTES = 64;

// Release candidates and their bundled process-tools are untrusted until the
// checks below have completed.  Keep the inherited environment deliberately
// small: in particular, never pass API keys, cloud credentials, SSH agents,
// package-manager tokens, or NODE_OPTIONS into a downloaded executable.
const VERIFICATION_ENVIRONMENT_KEYS = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"OS",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"NO_COLOR",
	"XDG_RUNTIME_DIR",
] as const;
const VERIFICATION_OVERRIDE_KEYS = new Set<string>([
	...VERIFICATION_ENVIRONMENT_KEYS,
	"PI_PACKAGE_DIR",
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	ENV_AGENT_DIR,
	ENV_PEER_MESSAGE_DB,
]);

/** Build the only environment a downloaded release candidate may observe. */
export function buildVerificationEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of VERIFICATION_ENVIRONMENT_KEYS) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (VERIFICATION_OVERRIDE_KEYS.has(key) && value !== undefined) environment[key] = value;
	}
	return environment;
}

interface ReleaseInputPathFingerprint {
	type: "file" | "directory";
	identity: string;
	digest: string;
}

interface ReleaseInputSnapshot {
	root: string;
	paths: readonly string[];
	fingerprints: ReadonlyMap<string, ReleaseInputPathFingerprint>;
}

function isPathInside(parent: string, child: string): boolean {
	const parentPath = resolve(parent);
	const childPath = resolve(child);
	return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`);
}

async function assertPrivateInputDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`Release input staging is not a real directory: ${path}`);
	}
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Release input staging is not owned by the current user: ${path}`);
	}
	if (platform() !== "win32" && (stats.mode & 0o077) !== 0) {
		throw new Error(`Release input staging is not private: ${path}`);
	}
}

/**
 * Create a private input root outside the installation directory. Downloads
 * and candidate verification happen here before an install lock is acquired.
 */
async function createReleaseInputDirectory(installDirectory: string): Promise<string> {
	const roots = [...new Set([tmpdir(), homedir(), dirname(resolve(installDirectory))])];
	for (const root of roots) {
		let candidate: string | undefined;
		try {
			candidate = await mkdtemp(join(root, "magenta-release-input-"));
			if (isPathInside(installDirectory, candidate)) {
				await rm(candidate, { recursive: true, force: true });
				candidate = undefined;
				continue;
			}
			await chmod(candidate, 0o700);
			await assertPrivateInputDirectory(candidate);
			return candidate;
		} catch (error) {
			if (candidate) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EACCES") {
				continue;
			}
			throw error;
		}
	}
	throw new Error("Unable to create private release input staging outside the installation directory");
}

function assertDirectSnapshotName(name: string): void {
	if (!name || name === "." || name === ".." || basename(name) !== name || name.includes("\\") || name.includes("/")) {
		throw new Error(`Unsafe release input snapshot path: ${name}`);
	}
}

function pathIdentity(stats: Awaited<ReturnType<typeof lstat>>): string {
	return [stats.dev, stats.ino, stats.size, stats.mode, stats.mtimeMs].join(":");
}

async function fingerprintReleaseInputPath(path: string): Promise<ReleaseInputPathFingerprint> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink()) throw new Error(`Release input snapshot contains a symbolic link: ${path}`);
	if (!stats.isFile() && !stats.isDirectory()) {
		throw new Error(`Release input snapshot contains an unsupported path: ${path}`);
	}
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Release input snapshot path is not owned by the current user: ${path}`);
	}
	if (stats.isFile()) {
		return {
			type: "file",
			identity: pathIdentity(stats),
			digest: await calculateFileSha256(path),
		};
	}

	const childNames = (await readdir(path)).sort();
	const childDigests: string[] = [];
	for (const childName of childNames) {
		assertDirectSnapshotName(childName);
		const child = await fingerprintReleaseInputPath(join(path, childName));
		childDigests.push(`${childName}\0${child.type}\0${child.digest}`);
	}
	const digest = createHash("sha256")
		.update(`directory\0${childDigests.join("\n")}`)
		.digest("hex");
	return { type: "directory", identity: pathIdentity(stats), digest };
}

async function captureReleaseInputSnapshot(root: string, paths: readonly string[]): Promise<ReleaseInputSnapshot> {
	await assertPrivateInputDirectory(root);
	const uniquePaths = [...new Set(paths)];
	const fingerprints = new Map<string, ReleaseInputPathFingerprint>();
	for (const path of uniquePaths) {
		assertDirectSnapshotName(path);
		fingerprints.set(path, await fingerprintReleaseInputPath(join(root, path)));
	}
	return { root, paths: uniquePaths, fingerprints };
}

function assertFingerprintEqual(
	path: string,
	expected: ReleaseInputPathFingerprint,
	actual: ReleaseInputPathFingerprint,
	options: { identity: boolean },
): void {
	if (
		actual.type !== expected.type ||
		actual.digest !== expected.digest ||
		(options.identity && actual.identity !== expected.identity)
	) {
		throw new Error(`Release input snapshot changed before activation: ${path}`);
	}
}

async function assertReleaseInputSnapshotUnchanged(snapshot: ReleaseInputSnapshot): Promise<void> {
	const current = await captureReleaseInputSnapshot(snapshot.root, snapshot.paths);
	for (const path of snapshot.paths) {
		const expected = snapshot.fingerprints.get(path);
		const actual = current.fingerprints.get(path);
		if (!expected || !actual) throw new Error(`Release input snapshot is incomplete: ${path}`);
		assertFingerprintEqual(path, expected, actual, { identity: true });
	}
}

async function copyReleaseInputPath(source: string, destination: string): Promise<void> {
	const stats = await lstat(source);
	if (stats.isSymbolicLink()) throw new Error(`Release input snapshot contains a symbolic link: ${source}`);
	if (stats.isDirectory()) {
		await mkdir(destination, { mode: stats.mode & 0o777 });
		for (const childName of (await readdir(source)).sort()) {
			assertDirectSnapshotName(childName);
			await copyReleaseInputPath(join(source, childName), join(destination, childName));
		}
		await chmod(destination, stats.mode & 0o777);
		return;
	}
	if (!stats.isFile()) throw new Error(`Release input snapshot contains an unsupported path: ${source}`);
	await copyFile(source, destination);
	await chmod(destination, stats.mode & 0o777);
}

async function copyReleaseInputSnapshotToStaging(
	snapshot: ReleaseInputSnapshot,
	stagingDirectory: string,
): Promise<void> {
	await assertPrivateInputDirectory(snapshot.root);
	await assertReleaseInputSnapshotUnchanged(snapshot);
	try {
		await assertPrivateInputDirectory(stagingDirectory);
		if ((await readdir(stagingDirectory)).length !== 0) {
			throw new Error(`Release activation staging is not empty: ${stagingDirectory}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(stagingDirectory, { mode: 0o700 });
		await assertPrivateInputDirectory(stagingDirectory);
	}
	for (const path of snapshot.paths) {
		assertDirectSnapshotName(path);
		await copyReleaseInputPath(join(snapshot.root, path), join(stagingDirectory, path));
	}
	// The source may have changed during a recursive copy. Re-check both the
	// source identity and the copied content before a transaction journal exists.
	await assertReleaseInputSnapshotUnchanged(snapshot);
	const copied = await captureReleaseInputSnapshot(stagingDirectory, snapshot.paths);
	for (const path of snapshot.paths) {
		const expected = snapshot.fingerprints.get(path);
		const actual = copied.fingerprints.get(path);
		if (!expected || !actual) throw new Error(`Copied release input is incomplete: ${path}`);
		assertFingerprintEqual(path, expected, actual, { identity: false });
	}
}

interface GitHubRelease {
	tag_name: string;
	name: string;
	body: string;
	published_at: string;
	assets: Array<{
		id: number;
		name: string;
		browser_download_url: string;
		url: string;
		size: number;
		digest?: string | null;
	}>;
}

export interface UpdateCheckResult {
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion?: string;
	releaseNotes?: string;
	downloadUrl?: string;
	releaseAssets?: ReleaseAssetPlan;
	error?: string;
}

export interface UpdateInstallResult {
	success: boolean;
	newVersion?: string;
	pending?: boolean;
	error?: string;
}

export interface PreviousWindowsUpdateErrorOptions {
	currentBinary?: string;
	force?: boolean;
}

/** Return and clear the asynchronous Windows helper failure from the previous launch. */
export async function consumePreviousWindowsUpdateError(
	options: PreviousWindowsUpdateErrorOptions = {},
): Promise<string | undefined> {
	if (platform() !== "win32" && !options.force) return undefined;
	const currentBinary = options.currentBinary ?? process.execPath;
	const errorLogPath = `${currentBinary}.update-error.log`;
	try {
		const message = (await readFile(errorLogPath, "utf8")).replace(/^\uFEFF/, "").trim();
		await rm(errorLogPath, { force: true });
		return message || "The previous Magenta update failed without an error message.";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function compareVersions(v1: string, v2: string): number {
	const normalize = (version: string): number[] => version.replace(/^v/, "").split(".").map(Number);
	const parts1 = normalize(v1);
	const parts2 = normalize(v2);

	for (let index = 0; index < Math.max(parts1.length, parts2.length); index++) {
		const left = parts1[index] || 0;
		const right = parts2[index] || 0;
		if (left !== right) return left - right;
	}
	return 0;
}

export async function shouldSkipConcurrentUpdateTransaction(
	installDirectory: string,
	installedVersion: string,
	targetVersion: string,
	/** Exact top-level ownership set from the verified target archive. */
	targetResourceNames?: readonly string[],
): Promise<boolean> {
	const versionComparison = compareVersions(installedVersion, targetVersion);
	if (versionComparison < 0) return false;
	if (await currentReleaseResourcesAreValid(installDirectory, installedVersion)) {
		// A same-version shortcut is valid only when the installed marker proves
		// the exact target ownership set. Otherwise an older marker can leave
		// remove-only resources behind indefinitely.
		if (versionComparison === 0 && targetResourceNames !== undefined) {
			try {
				const marker = await readInstalledReleaseOwnership(installDirectory);
				if (!marker.resourceNames) return false;
				const expected = new Set(targetResourceNames);
				const actual = new Set(marker.resourceNames);
				if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) return false;
			} catch {
				return false;
			}
		}
		return true;
	}
	if (versionComparison > 0) {
		throw new Error(
			`Another Magenta process installed newer v${installedVersion}, but its runtime resources are incomplete; refusing to overwrite it with older v${targetVersion}. Restart Magenta with network access to repair the installed release.`,
		);
	}
	return false;
}

/**
 * Re-read the installed executable only when the target directory actually
 * contains one. Resource-only repairs used by diagnostics may point at a
 * synthetic directory with no executable and should remain download-capable.
 */
async function shouldSkipConcurrentInstalledBinary(
	installDirectory: string,
	targetVersion: string,
	targetResourceNames?: readonly string[],
): Promise<boolean> {
	const installedBinary = join(installDirectory, basename(process.execPath));
	if (!existsSync(installedBinary)) return false;
	const installedVersion = readBinaryVersion(installedBinary, installDirectory);
	return shouldSkipConcurrentUpdateTransaction(installDirectory, installedVersion, targetVersion, targetResourceNames);
}

function getLastCheckFile(): string {
	return join(getConfigRootDir(), "last-update-check");
}

async function shouldCheckForUpdate(): Promise<boolean> {
	const checkFile = getLastCheckFile();
	try {
		const lastCheck = Number.parseInt(
			(await secureReadFile(checkFile, { maxBytes: UPDATE_CHECK_STATE_MAX_BYTES })).toString("utf8"),
			10,
		);
		return Date.now() - lastCheck > UPDATE_CHECK_INTERVAL_MS;
	} catch {
		return true;
	}
}

async function recordUpdateCheck(): Promise<void> {
	const checkFile = getLastCheckFile();
	await secureAtomicWriteFile(checkFile, `${Date.now()}\n`, {
		mode: 0o600,
		maxBytes: UPDATE_CHECK_STATE_MAX_BYTES,
	});
}

function positiveFiniteNumber(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0)
		throw new RangeError(`${label} must be a finite number greater than zero`);
	return value;
}

function nonNegativeFiniteNumber(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number`);
	return value;
}

function positiveSafeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`);
	return value;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted");
}

function waitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function getLatestRelease(timeoutMs = FETCH_TIMEOUT_MS): Promise<GitHubRelease | null> {
	positiveFiniteNumber(timeoutMs, "Release metadata timeout");
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`GitHub release metadata request timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	try {
		// Release metadata is the integrity root for asset digests, so it must
		// come directly from GitHub rather than the payload mirror.
		const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
		const response = await waitWithAbort(
			fetch(url, {
				headers: buildGitHubHeaders("application/vnd.github+json"),
				signal: controller.signal,
			}),
			controller.signal,
		);

		if (!response.ok) {
			if (response.status === 404) return null;
			const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
			const rateLimitReset = response.headers.get("x-ratelimit-reset");
			let detail = `GitHub API returned ${response.status}: ${response.statusText}`;
			if (response.status === 403 && rateLimitRemaining === "0" && rateLimitReset) {
				const resetDate = new Date(Number(rateLimitReset) * 1000);
				detail += `. Rate limit exceeded (resets at ${resetDate.toLocaleTimeString()}). Set MAGENTA_GITHUB_TOKEN to increase the limit, or wait and retry.`;
			}
			throw new Error(detail);
		}

		// fetch() resolves as soon as headers arrive. Keep the deadline armed
		// until the integrity-bearing JSON body has been consumed as well.
		return (await waitWithAbort(response.json(), controller.signal)) as GitHubRelease;
	} catch (error) {
		if (timedOut) {
			throw new Error(`GitHub release metadata request timed out after ${timeoutMs}ms`, { cause: error });
		}
		if (error instanceof Error) throw error;
		throw new Error(`Failed to fetch latest release: ${String(error)}`);
	} finally {
		clearTimeout(timeout);
	}
}

/** Resolve only architectures that the public release workflow actually publishes. */
export function getBinaryAssetName(
	runtimePlatform: NodeJS.Platform = platform(),
	runtimeArchitecture: string = arch(),
): string {
	if (runtimePlatform === "darwin" && runtimeArchitecture === "arm64") return "magenta-macos-arm64";
	if (runtimePlatform === "darwin" && runtimeArchitecture === "x64") return "magenta-macos-x64";
	if (runtimePlatform === "linux" && runtimeArchitecture === "x64") return "magenta-linux-x64";
	if (runtimePlatform === "win32" && runtimeArchitecture === "x64") return "magenta-windows-x64.exe";
	throw new Error(`Magenta self-update has no published binary for ${runtimePlatform} ${runtimeArchitecture}`);
}

function buildGitHubHeaders(accept: string, includeAuthorization = true): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: accept,
		"User-Agent": "Magenta-Auto-Update",
	};
	const githubToken = process.env.MAGENTA_GITHUB_TOKEN || "";
	if (includeAuthorization && githubToken) headers.Authorization = `Bearer ${githubToken}`;
	return headers;
}

/** @internal */
export function isRetryableDownloadError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof ReleaseAssetDownloadError) return error.retryable;
	const message = error.message.toLowerCase();
	return (
		error.name === "AbortError" ||
		message.includes("aborted") ||
		message.includes("timeout") ||
		message.includes("econnreset") ||
		message.includes("etimedout") ||
		message.includes("socket connection was closed") ||
		message.includes("unable to connect") ||
		message.includes("fetch failed")
	);
}

class ReleaseAssetDownloadError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReleaseAssetDownloadError";
		this.retryable = retryable;
	}
}

export interface ReleaseAssetDownloadOptions {
	useMirror?: boolean;
	retryDelayMs?: number;
	wallTimeoutMs?: number;
	inactivityTimeoutMs?: number;
	maxBytes?: number;
}

interface NormalizedReleaseAssetDownloadOptions {
	useMirror: boolean;
	retryDelayMs: number;
	wallTimeoutMs: number;
	inactivityTimeoutMs: number;
	maxBytes: number;
}

function normalizeReleaseAssetDownloadOptions(
	options: ReleaseAssetDownloadOptions,
): NormalizedReleaseAssetDownloadOptions {
	return {
		useMirror: options.useMirror !== false,
		retryDelayMs: nonNegativeFiniteNumber(options.retryDelayMs ?? 2_000, "Download retry delay"),
		wallTimeoutMs: positiveFiniteNumber(options.wallTimeoutMs ?? DOWNLOAD_WALL_TIMEOUT_MS, "Download wall timeout"),
		inactivityTimeoutMs: positiveFiniteNumber(
			options.inactivityTimeoutMs ?? DOWNLOAD_INACTIVITY_TIMEOUT_MS,
			"Download inactivity timeout",
		),
		maxBytes: positiveSafeInteger(options.maxBytes ?? DOWNLOAD_MAX_BYTES, "Download byte limit"),
	};
}

function downloadWallTimeoutError(
	assetName: string,
	wallTimeoutMs: number,
	attempts: number,
): ReleaseAssetDownloadError {
	return new ReleaseAssetDownloadError(
		`Download of ${assetName} exceeded its ${wallTimeoutMs}ms total wall-clock timeout after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
		false,
	);
}

async function waitForDownloadRetry(
	delayMs: number,
	deadline: number,
	assetName: string,
	wallTimeoutMs: number,
	attempts: number,
): Promise<void> {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) throw downloadWallTimeoutError(assetName, wallTimeoutMs, attempts);
	const boundedDelayMs = Math.min(delayMs, remainingMs);
	if (boundedDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, boundedDelayMs));
	if (Date.now() >= deadline) throw downloadWallTimeoutError(assetName, wallTimeoutMs, attempts);
}

/**
 * Download a release asset with inactivity and total deadlines, a byte limit,
 * and bounded retries. Exported for testing.
 * @internal
 */
export async function downloadReleaseAsset(
	asset: ReleaseAssetPlan[keyof ReleaseAssetPlan],
	destination: string,
	options: ReleaseAssetDownloadOptions = {},
): Promise<void> {
	const normalized = normalizeReleaseAssetDownloadOptions(options);
	const deadline = Date.now() + normalized.wallTimeoutMs;
	const downloadUrl = normalized.useMirror ? resolveGitHubUrl(asset.downloadUrl) : asset.downloadUrl;

	for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
		if (Date.now() >= deadline) throw downloadWallTimeoutError(asset.name, normalized.wallTimeoutMs, attempt - 1);

		const controller = new AbortController();
		let wallTimer: NodeJS.Timeout | undefined;
		let inactivityTimer: NodeJS.Timeout | undefined;
		let destinationCreated = false;
		let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
		let responseBody: ReadableStream<Uint8Array> | undefined;
		let bodyOwnedByPipeline = false;

		const clearAttemptTimers = () => {
			if (wallTimer) clearTimeout(wallTimer);
			if (inactivityTimer) clearTimeout(inactivityTimer);
			wallTimer = undefined;
			inactivityTimer = undefined;
		};
		const abortAttempt = (error: ReleaseAssetDownloadError) => {
			if (!controller.signal.aborted) controller.abort(error);
		};
		const resetInactivityTimeout = () => {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(() => {
				abortAttempt(
					new ReleaseAssetDownloadError(
						`Download of ${asset.name} stalled: no data was received for ${normalized.inactivityTimeoutMs}ms (attempt ${attempt}/${DOWNLOAD_MAX_RETRIES})`,
						true,
					),
				);
			}, normalized.inactivityTimeoutMs);
		};

		try {
			wallTimer = setTimeout(
				() => {
					abortAttempt(downloadWallTimeoutError(asset.name, normalized.wallTimeoutMs, attempt));
				},
				Math.max(1, deadline - Date.now()),
			);
			resetInactivityTimeout();

			const response = await waitWithAbort(
				fetch(downloadUrl, {
					// Release assets are public. Keep Authorization confined to the
					// direct API metadata request; redirects and mirrors must never see it.
					headers: buildGitHubHeaders("application/octet-stream", false),
					signal: controller.signal,
				}),
				controller.signal,
			);
			if (!response.ok) {
				const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
				throw new ReleaseAssetDownloadError(
					`Download failed for ${asset.name}: ${response.status} ${response.statusText}`,
					retryableStatus,
				);
			}
			if (!response.body) throw new ReleaseAssetDownloadError(`Download returned no body for ${asset.name}`, true);
			responseBody = response.body;

			const contentLength = response.headers.get("content-length")?.trim();
			if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(normalized.maxBytes)) {
				throw new ReleaseAssetDownloadError(
					`Download of ${asset.name} declares ${contentLength} bytes, exceeding the ${normalized.maxBytes}-byte limit`,
					false,
				);
			}

			controller.signal.throwIfAborted();
			destinationHandle = await open(destination, "wx", 0o600);
			destinationCreated = true;
			controller.signal.throwIfAborted();

			let downloadedBytes = 0;
			const byteLimiter = new Transform({
				transform(chunk, encoding, callback) {
					resetInactivityTimeout();
					const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
					downloadedBytes += chunkBytes;
					if (downloadedBytes > normalized.maxBytes) {
						callback(
							new ReleaseAssetDownloadError(
								`Download of ${asset.name} exceeded the ${normalized.maxBytes}-byte limit while streaming`,
								false,
							),
						);
						return;
					}
					callback(null, chunk);
				},
				flush(callback) {
					if (inactivityTimer) clearTimeout(inactivityTimer);
					inactivityTimer = undefined;
					callback();
				},
			});
			const nodeStream = Readable.fromWeb(responseBody as Parameters<typeof Readable.fromWeb>[0]);
			bodyOwnedByPipeline = true;
			await pipeline(nodeStream, byteLimiter, destinationHandle.createWriteStream(), { signal: controller.signal });
			destinationHandle = undefined;
			controller.signal.throwIfAborted();
			return;
		} catch (rawError) {
			const error = controller.signal.aborted
				? abortReason(controller.signal)
				: rawError instanceof Error
					? rawError
					: new Error(String(rawError));
			clearAttemptTimers();
			if (!bodyOwnedByPipeline && responseBody) await responseBody.cancel().catch(() => undefined);
			if (destinationHandle) await destinationHandle.close().catch(() => undefined);
			if (destinationCreated) {
				try {
					await rm(destination, { force: true });
				} catch (cleanupError) {
					throw new Error(`Failed to remove partial download ${destination} after: ${error.message}`, {
						cause: cleanupError,
					});
				}
			}

			if (!isRetryableDownloadError(error) || attempt === DOWNLOAD_MAX_RETRIES) {
				if (
					!(error instanceof ReleaseAssetDownloadError) &&
					(error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
				) {
					throw new ReleaseAssetDownloadError(
						`Download of ${asset.name} stalled after ${attempt} attempts. Check your network connection or try setting MAGENTA_GITHUB_MIRROR to use a download mirror.`,
						false,
						{ cause: error },
					);
				}
				throw error;
			}

			console.warn(
				`⚠️  Download interrupted for ${asset.name} (attempt ${attempt}/${DOWNLOAD_MAX_RETRIES}), retrying...`,
			);
			await waitForDownloadRetry(
				normalized.retryDelayMs * attempt,
				deadline,
				asset.name,
				normalized.wallTimeoutMs,
				attempt,
			);
		} finally {
			clearAttemptTimers();
		}
	}
}

function runBinary(
	binaryPath: string,
	args: readonly string[],
	packageDirectory: string,
	environment: NodeJS.ProcessEnv = {},
) {
	return spawnSync(binaryPath, [...args], {
		cwd: packageDirectory,
		encoding: "utf8",
		env: buildVerificationEnvironment({ ...environment, PI_PACKAGE_DIR: packageDirectory }),
		maxBuffer: 4 * 1024 * 1024,
		timeout: BINARY_VERIFICATION_TIMEOUT_MS,
	});
}

/**
 * Exercise the non-pure help path in an isolated staged profile so the embedded
 * process-tools payload is extracted and verified without touching user state.
 */
export function assertStagedBinaryStartup(
	binaryPath: string,
	packageDirectory: string,
	runtimePlatform: NodeJS.Platform = platform(),
): void {
	const smokeHome = join(packageDirectory, ".magenta-smoke-home");
	const result = runBinary(binaryPath, ["--help", "--offline", "smoke"], packageDirectory, {
		HOME: smokeHome,
		USERPROFILE: smokeHome,
		[ENV_AGENT_DIR]: join(smokeHome, "agent"),
		[ENV_PEER_MESSAGE_DB]: join(smokeHome, "messages.db"),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = `${result.stdout}${result.stderr}`.trim();
		throw new Error(
			`Staged binary startup verification failed with exit code ${String(result.status)}${detail ? `: ${detail}` : ""}`,
		);
	}
	assertPackagedProcessToolsStart(packageDirectory, runtimePlatform);
}

/** Include the helper tree generated by the staged smoke run in the atomic install. */
export function getUpdateTransactionResourceNames(archiveResourceNames: readonly string[]): string[] {
	return [...new Set([...archiveResourceNames, RELEASE_RESOURCE_MARKER_NAME, "_magenta"])];
}

export function readBinaryVersion(binaryPath: string, packageDirectory: string): string {
	const result = runBinary(binaryPath, ["--version"], packageDirectory);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Binary version verification failed with exit code ${String(result.status)}`);
	}
	return result.stdout.trim();
}

export function assertBinaryVersion(binaryPath: string, expectedVersion: string, packageDirectory: string): void {
	const actualVersion = readBinaryVersion(binaryPath, packageDirectory);
	if (actualVersion !== expectedVersion) {
		throw new Error(`Binary version mismatch: expected ${expectedVersion}, got ${actualVersion || "no output"}`);
	}
}

export function assertBinaryHelp(binaryPath: string, packageDirectory: string): void {
	const result = runBinary(binaryPath, ["--help"], packageDirectory);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = result.stderr.trim();
		throw new Error(
			`Binary startup verification failed with exit code ${String(result.status)}${detail ? `: ${detail}` : ""}`,
		);
	}
}

/** @internal */
export function assertPackagedProcessToolsStart(
	packageDirectory: string,
	runtimePlatform: NodeJS.Platform = platform(),
): void {
	const binaryName = runtimePlatform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools";
	const binaryPath = join(packageDirectory, "_magenta", "process-tools", "target", "release", binaryName);
	if (!existsSync(binaryPath)) throw new Error(`Staged process-tools binary is missing: ${binaryPath}`);

	const result = runBinary(binaryPath, ["--help"], packageDirectory);
	if (result.error) throw new Error(`Staged process-tools binary failed to start: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = result.stderr.trim();
		throw new Error(`Staged process-tools binary failed --help${detail ? `: ${detail}` : ""}`);
	}
}

/** @internal Exported for platform-specific archive extraction tests. */
export function getReleaseArchiveExtractArgs(
	archivePath: string,
	stagingDirectory: string,
	runtimePlatform: NodeJS.Platform = platform(),
): string[] {
	const commonArgs = ["-xzf", archivePath, "-C", stagingDirectory];
	// A privileged tar otherwise restores the build runner's numeric UID. The
	// update transaction must receive resources owned by the installing user.
	return runtimePlatform === "win32" ? commonArgs : ["--no-same-owner", ...commonArgs];
}

export function extractReleaseResources(archivePath: string, stagingDirectory: string): void {
	const runtimePlatform = platform();
	const tarCommand = runtimePlatform === "win32" ? "tar.exe" : "tar";
	const result = spawnSync(tarCommand, getReleaseArchiveExtractArgs(archivePath, stagingDirectory, runtimePlatform), {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		timeout: ARCHIVE_EXTRACTION_TIMEOUT_MS,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Failed to extract runtime resources (tar exit ${String(result.status)}): ${result.stderr.trim()}`,
		);
	}
}

async function launchWindowsUpdateHelper(
	operationId: string,
	scriptPath: string,
	stagingDirectory: string,
	backupDirectory: string,
	resourceNames: readonly string[],
	removeResourceNames: readonly string[],
	currentBinary: string,
	targetVersion: string,
): Promise<void> {
	const errorLogPath = `${currentBinary}.update-error.log`;
	const parentProcessStartTimeUtc = getWindowsReleaseUpdateProcessStartTimeUtc(process.pid);
	if (!parentProcessStartTimeUtc) {
		throw new Error("Unable to identify the current Windows process before launching the update helper");
	}
	await rm(errorLogPath, { force: true });
	const script = buildWindowsUpdateScript({
		parentProcessId: process.pid,
		parentProcessStartTimeUtc,
		operationId,
		currentBinary,
		stagingDirectory,
		backupDirectory,
		resourceNames,
		removeResourceNames,
		targetVersion,
		scriptPath,
		errorLogPath,
	});
	await writeFile(scriptPath, script, "utf8");

	let child: ReturnType<typeof spawn> | undefined;
	try {
		const spawnedChild = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{
				detached: true,
				stdio: "ignore",
				windowsHide: true,
				env: buildVerificationEnvironment({
					PI_PACKAGE_DIR: dirname(currentBinary),
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
				}),
			},
		);
		child = spawnedChild;
		await new Promise<void>((resolve, reject) => {
			spawnedChild.once("spawn", resolve);
			spawnedChild.once("error", reject);
		});
		const helperPid = spawnedChild.pid;
		if (!helperPid) throw new Error("Windows update helper did not expose a process ID");
		const helperStartTimeUtc = getWindowsReleaseUpdateProcessStartTimeUtc(helperPid);
		if (!helperStartTimeUtc) throw new Error("Unable to identify the Windows update helper process");
		// The parent still owns the install lock here.  Bind the PID before the
		// lock can be released so another Magenta process must defer recovery.
		await bindWindowsReleaseUpdateHelper({
			installDirectory: dirname(currentBinary),
			operationId,
			helperPid,
			helperStartTimeUtc,
		});
		spawnedChild.unref();
	} catch (error) {
		child?.kill();
		await rm(scriptPath, { force: true });
		throw error;
	}
}

export async function lockInstallMutation(
	installDirectory: string,
	options: { retries?: number } = {},
): Promise<() => Promise<void>> {
	const assertOwnedDirectory = async (path: string): Promise<void> => {
		const stats = await lstat(path);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe install lock path: ${path}`);
		if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
			throw new Error(`Install lock path is not owned by the current user: ${path}`);
		}
	};
	await assertOwnedDirectory(installDirectory);
	const lockPath = join(installDirectory, RELEASE_INSTALL_LOCK_NAME);
	try {
		await assertOwnedDirectory(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const release = await lockfile.lock(installDirectory, {
		realpath: false,
		lockfilePath: lockPath,
		retries: { retries: options.retries ?? 120, factor: 1, minTimeout: 250, maxTimeout: 250 },
		stale: INSTALL_LOCK_STALE_MS,
		update: 10_000,
	});
	try {
		await assertOwnedDirectory(lockPath);
		if (platform() !== "win32") await chmod(lockPath, 0o700);
		return release;
	} catch (error) {
		await release();
		throw error;
	}
}

export interface EnsureCurrentReleaseResourcesOptions {
	offline?: boolean;
	force?: boolean;
	installDirectory?: string;
	version?: string;
	assetBaseUrl?: string;
}

export async function ensureCurrentReleaseResources(
	options: EnsureCurrentReleaseResourcesOptions = {},
): Promise<boolean> {
	if (!isBunBinary && !options.force) return false;
	const version = options.version ?? VERSION;
	const installDirectory = options.installDirectory ?? dirname(process.execPath);
	const wasAlreadyValid = await currentReleaseResourcesAreValid(installDirectory, version);
	if (wasAlreadyValid || options.offline) {
		const release = await lockInstallMutation(installDirectory);
		try {
			await recoverInterruptedReleaseUpdateTransaction(installDirectory, { runningVersion: version });
			if (await currentReleaseResourcesAreValid(installDirectory, version)) return false;
			if (options.offline) {
				throw new Error(
					`Magenta ${version} runtime resources are missing or version-mismatched, and --offline prevents repair. Start Magenta once with network access to repair the installation.`,
				);
			}
		} finally {
			await release();
		}
	}

	const inputDirectory = await createReleaseInputDirectory(installDirectory);
	const operationId = randomUUID().replaceAll("-", "");
	const stagingDirectory = join(installDirectory, `.magenta-resource-staging-${operationId}`);
	const backupDirectory = join(installDirectory, `.magenta-resource-backup-${operationId}`);
	const checksumsPath = join(inputDirectory, RELEASE_CHECKSUMS_ASSET_NAME);
	const resourcesPath = join(inputDirectory, RELEASE_RESOURCES_ASSET_NAME);
	const assetBaseUrl =
		options.assetBaseUrl?.replace(/\/$/, "") ?? `https://github.com/${GITHUB_REPO}/releases/download/v${version}`;

	console.log(`📦 Repairing version-matched Magenta ${version} runtime resources...`);
	try {
		await downloadReleaseAsset(
			{
				name: RELEASE_CHECKSUMS_ASSET_NAME,
				downloadUrl: `${assetBaseUrl}/${RELEASE_CHECKSUMS_ASSET_NAME}`,
			},
			checksumsPath,
			{ useMirror: false },
		);
		await downloadReleaseAsset(
			{
				name: RELEASE_RESOURCES_ASSET_NAME,
				downloadUrl: `${assetBaseUrl}/${RELEASE_RESOURCES_ASSET_NAME}`,
			},
			resourcesPath,
			{ useMirror: options.assetBaseUrl === undefined },
		);

		const checksums = parseReleaseChecksums(await readFile(checksumsPath, "utf8"));
		await verifyReleaseArtifactChecksums(checksums, [{ name: RELEASE_RESOURCES_ASSET_NAME, path: resourcesPath }]);
		const archiveResourceNames = await inspectReleaseResourceArchive(resourcesPath);
		extractReleaseResources(resourcesPath, inputDirectory);
		await validateExtractedReleaseResources(inputDirectory, archiveResourceNames, version);
		const resourceNames = [...new Set([...archiveResourceNames, RELEASE_RESOURCE_MARKER_NAME])];
		const inputSnapshot = await captureReleaseInputSnapshot(inputDirectory, resourceNames);

		const releaseLock = await lockInstallMutation(installDirectory);
		let transactionJournalCreated = false;
		try {
			await recoverInterruptedReleaseUpdateTransaction(installDirectory, { runningVersion: version });
			const resourcesAreValid = await currentReleaseResourcesAreValid(installDirectory, version);
			const installedBinary = join(installDirectory, basename(process.execPath));
			if (await shouldSkipConcurrentInstalledBinary(installDirectory, version, resourceNames)) return false;
			if (resourcesAreValid && !existsSync(installedBinary)) return false;
			if (resourcesAreValid && existsSync(installedBinary)) {
				// A same-version binary with a stale ownership marker must still be
				// repaired so retired managed resources cannot survive indefinitely.
				const installedVersion = readBinaryVersion(installedBinary, installDirectory);
				if (compareVersions(installedVersion, version) < 0) return false;
			}
			await mkdir(stagingDirectory, { mode: 0o700 });
			await initializeReleaseUpdateTransaction({
				installDirectory,
				operationId,
				kind: "resources",
				targetVersion: version,
			});
			transactionJournalCreated = true;
			await assertReleaseInputSnapshotUnchanged(inputSnapshot);
			await copyReleaseInputSnapshotToStaging(inputSnapshot, stagingDirectory);
			const cleanupWarnings = await applyResourceUpdateTransaction({
				installDirectory,
				operationId,
				stagingDirectory,
				backupDirectory,
				resourceNames,
				targetVersion: version,
				verifyInstalled: async () => {
					if (!(await currentReleaseResourcesAreValid(installDirectory, version))) {
						throw new Error(`Installed runtime resources do not match Magenta ${version}`);
					}
				},
			});
			for (const warning of cleanupWarnings) console.warn(`Resource cleanup warning: ${warning}`);
			console.log(`✅ Repaired Magenta ${version} runtime resources.`);
			return true;
		} finally {
			if (transactionJournalCreated) {
				await recoverInterruptedReleaseUpdateTransaction(installDirectory, { runningVersion: version });
			} else {
				await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
			}
			await releaseLock();
		}
	} finally {
		await rm(inputDirectory, { recursive: true, force: true }).catch(() => undefined);
	}
}

export interface UpdateCheckOptions {
	force?: boolean;
	/** @internal Override used by bounded-time regression tests. */
	metadataTimeoutMs?: number;
}

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
	if (!options.force && !(await shouldCheckForUpdate())) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
		};
	}

	let release: GitHubRelease | null;
	try {
		release = await getLatestRelease(options.metadataTimeoutMs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			updateAvailable: false,
			currentVersion: VERSION,
			error: `Could not fetch latest release: ${message}`,
		};
	}
	// Update discovery must remain usable when this reconstructable throttle
	// marker cannot be persisted (read-only home, unsafe link, or a concurrent writer).
	await recordUpdateCheck().catch(() => undefined);

	if (!release) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
			error: "Could not fetch latest release (API returned 404 or empty response)",
		};
	}

	const latestVersion = release.tag_name.replace(/^v/, "");
	const updateAvailable = compareVersions(latestVersion, VERSION) > 0;
	if (!updateAvailable) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
			latestVersion,
		};
	}

	try {
		const releaseAssets = resolveReleaseAssetPlan(release.assets, getBinaryAssetName());
		return {
			updateAvailable: true,
			currentVersion: VERSION,
			latestVersion,
			releaseNotes: release.body,
			downloadUrl: releaseAssets.binary.downloadUrl,
			releaseAssets,
		};
	} catch (error) {
		return {
			updateAvailable: true,
			currentVersion: VERSION,
			latestVersion,
			releaseNotes: release.body,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function backgroundUpdateNotification(): Promise<void> {
	try {
		const result = await checkForUpdate();
		if (result.updateAvailable && result.latestVersion && !result.error) {
			console.log(
				`\n💡 New Magenta version v${result.latestVersion} available. Run 'magenta update self' to upgrade.\n`,
			);
		}
	} catch {
		return;
	}
}

export async function installUpdate(): Promise<UpdateInstallResult> {
	if (!isBunBinary) {
		return {
			success: false,
			error: "Self-update only works for compiled Magenta binaries. Currently running via Node.js; skipping self-update to avoid overwriting Node.js.",
		};
	}

	const checkResult = await checkForUpdate({ force: true });
	if (checkResult.error) return { success: false, error: checkResult.error };
	if (!checkResult.updateAvailable) {
		return { success: false, error: `Already on latest version (${VERSION})` };
	}
	if (!checkResult.releaseAssets || !checkResult.latestVersion) {
		return { success: false, error: "Update information incomplete" };
	}

	const currentBinary = process.execPath;
	const installDirectory = dirname(currentBinary);
	const operationId = randomUUID().replaceAll("-", "");
	const binaryName = basename(currentBinary);
	let windowsHelperOwnsStaging = false;

	try {
		const inputDirectory = await createReleaseInputDirectory(installDirectory);
		const inputBinary = join(inputDirectory, binaryName);
		const checksumsPath = join(inputDirectory, RELEASE_CHECKSUMS_ASSET_NAME);
		const resourcesPath = join(inputDirectory, RELEASE_RESOURCES_ASSET_NAME);
		try {
			console.log(`📦 Downloading Magenta v${checkResult.latestVersion} and runtime resources...`);
			const checksumAsset = checkResult.releaseAssets.checksums;
			// A mirrored checksum manifest is safe only when the direct GitHub API
			// supplied a digest that can authenticate the manifest itself.
			await downloadReleaseAsset(checksumAsset, checksumsPath, {
				useMirror: shouldUseMirrorForReleaseAsset(checksumAsset),
			});
			await verifyReleaseAssetDigest(checksumAsset, checksumsPath);
			await downloadReleaseAsset(checkResult.releaseAssets.binary, inputBinary);
			await downloadReleaseAsset(checkResult.releaseAssets.resources, resourcesPath);

			// Verify API digests when GitHub publishes them, then also enforce the
			// release manifest so older releases without API digests remain safe.
			await verifyReleaseAssetDigest(checkResult.releaseAssets.binary, inputBinary);
			await verifyReleaseAssetDigest(checkResult.releaseAssets.resources, resourcesPath);
			const checksums = parseReleaseChecksums(await readFile(checksumsPath, "utf8"));
			await verifyReleaseArtifactChecksums(checksums, [
				{ name: checkResult.releaseAssets.binary.name, path: inputBinary },
				{ name: checkResult.releaseAssets.resources.name, path: resourcesPath },
			]);

			const archiveResourceNames = await inspectReleaseResourceArchive(resourcesPath);
			extractReleaseResources(resourcesPath, inputDirectory);
			await validateExtractedReleaseResources(inputDirectory, archiveResourceNames, checkResult.latestVersion);
			if (platform() !== "win32") await chmod(inputBinary, 0o755);
			if (platform() === "darwin") verifyMacosReleaseCandidate(inputBinary);
			assertBinaryVersion(inputBinary, checkResult.latestVersion, inputDirectory);
			assertBinaryHelp(inputBinary, inputDirectory);
			assertStagedBinaryStartup(inputBinary, inputDirectory);
			const resourceNames = getUpdateTransactionResourceNames(archiveResourceNames);
			const inputSnapshot = await captureReleaseInputSnapshot(inputDirectory, [binaryName, ...resourceNames]);

			const installLock = await lockInstallMutation(installDirectory);
			const stagingDirectory = join(installDirectory, `.magenta-update-staging-${operationId}`);
			const backupDirectory = join(installDirectory, `.magenta-update-backup-${operationId}`);
			const scriptPath = join(installDirectory, `.magenta-update-${operationId}.ps1`);
			let transactionJournalCreated = false;
			try {
				await recoverInterruptedReleaseUpdateTransaction(installDirectory, { runningVersion: VERSION });
				const lockedInstalledVersion = readBinaryVersion(currentBinary, installDirectory);
				if (
					await shouldSkipConcurrentUpdateTransaction(
						installDirectory,
						lockedInstalledVersion,
						checkResult.latestVersion,
						resourceNames,
					)
				) {
					console.log(
						`Another Magenta process already installed v${lockedInstalledVersion}; skipping this transaction.`,
					);
					return { success: true, newVersion: lockedInstalledVersion };
				}
				await mkdir(stagingDirectory, { mode: 0o700 });
				await initializeReleaseUpdateTransaction({
					installDirectory,
					operationId,
					kind: platform() === "win32" ? "windows" : "unix",
					binaryName,
					originalBinaryPresent: true,
					targetVersion: checkResult.latestVersion,
				});
				transactionJournalCreated = true;
				await assertReleaseInputSnapshotUnchanged(inputSnapshot);
				await copyReleaseInputSnapshotToStaging(inputSnapshot, stagingDirectory);

				if (platform() === "win32") {
					const preparedWindows = await prepareWindowsReleaseUpdateTransaction({
						installDirectory,
						operationId,
						currentBinary,
						stagingDirectory,
						backupDirectory,
						resourceNames,
						targetVersion: checkResult.latestVersion,
					});
					await launchWindowsUpdateHelper(
						operationId,
						scriptPath,
						stagingDirectory,
						backupDirectory,
						resourceNames,
						preparedWindows.removeResourceNames,
						currentBinary,
						checkResult.latestVersion,
					);
					windowsHelperOwnsStaging = true;
					console.log(`✅ Magenta v${checkResult.latestVersion} is verified and ready to install.`);
					console.log("The update will complete automatically after this Magenta process exits.");
					return { success: true, newVersion: checkResult.latestVersion, pending: true };
				}

				const cleanupWarnings = await applyUnixUpdateTransaction({
					currentBinary,
					operationId,
					stagingDirectory,
					backupDirectory,
					resourceNames,
					targetVersion: checkResult.latestVersion,
					verifyInstalled: () =>
						assertBinaryVersion(currentBinary, checkResult.latestVersion as string, installDirectory),
				});
				for (const warning of cleanupWarnings) console.warn(`Update cleanup warning: ${warning}`);

				console.log(`✅ Updated to v${checkResult.latestVersion}`);
				if (checkResult.releaseNotes) console.log(`\nRelease notes:\n${checkResult.releaseNotes}\n`);
				console.log("Please restart Magenta to use the new version.");
				return { success: true, newVersion: checkResult.latestVersion };
			} finally {
				if (transactionJournalCreated && !windowsHelperOwnsStaging) {
					await recoverInterruptedReleaseUpdateTransaction(installDirectory, { runningVersion: VERSION }).catch(
						() => undefined,
					);
				} else if (!transactionJournalCreated) {
					await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
				}
				await installLock();
			}
		} finally {
			await rm(inputDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
