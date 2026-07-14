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
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import lockfile from "proper-lockfile";
import { isBunBinary, VERSION } from "../config.ts";
import { resolveGitHubUrl } from "./github-mirror.ts";
import {
	applyResourceUpdateTransaction,
	applyUnixUpdateTransaction,
	buildWindowsUpdateScript,
	currentReleaseResourcesAreValid,
	inspectReleaseResourceArchive,
	parseReleaseChecksums,
	RELEASE_CHECKSUMS_ASSET_NAME,
	RELEASE_INSTALL_LOCK_NAME,
	RELEASE_RESOURCE_MARKER_NAME,
	RELEASE_RESOURCES_ASSET_NAME,
	type ReleaseAssetPlan,
	resolveReleaseAssetPlan,
	validateExtractedReleaseResources,
	verifyReleaseArtifactChecksums,
} from "./github-release-update-support.ts";

const GITHUB_REPO = process.env.MAGENTA_GITHUB_REPO || "Minions-Land/Magenta-CLI";
const GITHUB_TOKEN = process.env.MAGENTA_GITHUB_TOKEN || "";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const BINARY_VERIFICATION_TIMEOUT_MS = 30_000;

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
): Promise<boolean> {
	const versionComparison = compareVersions(installedVersion, targetVersion);
	if (versionComparison < 0) return false;
	if (await currentReleaseResourcesAreValid(installDirectory, installedVersion)) return true;
	if (versionComparison > 0) {
		throw new Error(
			`Another Magenta process installed newer v${installedVersion}, but its runtime resources are incomplete; refusing to overwrite it with older v${targetVersion}. Restart Magenta with network access to repair the installed release.`,
		);
	}
	return false;
}

function getLastCheckFile(): string {
	return join(homedir(), ".magenta", "last-update-check");
}

async function shouldCheckForUpdate(): Promise<boolean> {
	const checkFile = getLastCheckFile();
	if (!existsSync(checkFile)) return true;

	try {
		const lastCheck = Number.parseInt(await readFile(checkFile, "utf8"), 10);
		return Date.now() - lastCheck > UPDATE_CHECK_INTERVAL_MS;
	} catch {
		return true;
	}
}

async function recordUpdateCheck(): Promise<void> {
	const checkFile = getLastCheckFile();
	await mkdir(dirname(checkFile), { recursive: true });
	await writeFile(checkFile, Date.now().toString(), "utf8");
}

async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function getLatestRelease(): Promise<GitHubRelease | null> {
	try {
		const url = resolveGitHubUrl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
		const response = await fetchWithTimeout(url, {
			headers: buildGitHubHeaders("application/vnd.github+json"),
		});

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

		return (await response.json()) as GitHubRelease;
	} catch (error) {
		if (error instanceof Error) throw error;
		throw new Error(`Failed to fetch latest release: ${String(error)}`);
	}
}

function getBinaryAssetName(): string {
	const currentPlatform = platform();
	const currentArchitecture = arch();
	if (currentPlatform === "darwin") {
		return currentArchitecture === "arm64" ? "magenta-macos-arm64" : "magenta-macos-x64";
	}
	if (currentPlatform === "linux") return "magenta-linux-x64";
	if (currentPlatform === "win32") return "magenta-windows-x64.exe";
	return "magenta";
}

function buildGitHubHeaders(accept: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: accept,
		"User-Agent": "Magenta-Auto-Update",
	};
	if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
	return headers;
}

async function downloadReleaseAsset(
	asset: ReleaseAssetPlan[keyof ReleaseAssetPlan],
	destination: string,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

	try {
		const response = await fetch(resolveGitHubUrl(asset.downloadUrl), {
			headers: buildGitHubHeaders("application/octet-stream"),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Download failed for ${asset.name}: ${response.status} ${response.statusText}`);
		}
		if (!response.body) throw new Error(`Download returned no body for ${asset.name}`);

		const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
		await pipeline(Readable.fromWeb(webStream), createWriteStream(destination, { flags: "wx" }));
	} finally {
		clearTimeout(timeout);
	}
}

function runBinary(binaryPath: string, args: readonly string[], packageDirectory: string) {
	return spawnSync(binaryPath, [...args], {
		cwd: packageDirectory,
		encoding: "utf8",
		env: {
			...process.env,
			PI_PACKAGE_DIR: packageDirectory,
		},
		maxBuffer: 4 * 1024 * 1024,
		timeout: BINARY_VERIFICATION_TIMEOUT_MS,
	});
}

function readBinaryVersion(binaryPath: string, packageDirectory: string): string {
	const result = runBinary(binaryPath, ["--version"], packageDirectory);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Binary version verification failed with exit code ${String(result.status)}`);
	}
	return result.stdout.trim();
}

function assertBinaryVersion(binaryPath: string, expectedVersion: string, packageDirectory: string): void {
	const actualVersion = readBinaryVersion(binaryPath, packageDirectory);
	if (actualVersion !== expectedVersion) {
		throw new Error(`Binary version mismatch: expected ${expectedVersion}, got ${actualVersion || "no output"}`);
	}
}

function assertBinaryHelp(binaryPath: string, packageDirectory: string): void {
	const result = runBinary(binaryPath, ["--help"], packageDirectory);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = result.stderr.trim();
		throw new Error(
			`Binary startup verification failed with exit code ${String(result.status)}${detail ? `: ${detail}` : ""}`,
		);
	}
}

function extractReleaseResources(archivePath: string, stagingDirectory: string): void {
	const tarCommand = platform() === "win32" ? "tar.exe" : "tar";
	const result = spawnSync(tarCommand, ["-xzf", archivePath, "-C", stagingDirectory], {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		timeout: DOWNLOAD_TIMEOUT_MS,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Failed to extract runtime resources (tar exit ${String(result.status)}): ${result.stderr.trim()}`,
		);
	}
}

async function launchWindowsUpdateHelper(
	scriptPath: string,
	stagingDirectory: string,
	backupDirectory: string,
	resourceNames: readonly string[],
	currentBinary: string,
	targetVersion: string,
): Promise<void> {
	const errorLogPath = `${currentBinary}.update-error.log`;
	await rm(errorLogPath, { force: true });
	const script = buildWindowsUpdateScript({
		parentProcessId: process.pid,
		currentBinary,
		stagingDirectory,
		backupDirectory,
		resourceNames,
		targetVersion,
		scriptPath,
		errorLogPath,
	});
	await writeFile(scriptPath, script, "utf8");

	try {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			},
		);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.unref();
	} catch (error) {
		await rm(scriptPath, { force: true });
		throw error;
	}
}

async function lockInstallMutation(installDirectory: string): Promise<() => Promise<void>> {
	return lockfile.lock(installDirectory, {
		realpath: false,
		lockfilePath: join(installDirectory, RELEASE_INSTALL_LOCK_NAME),
		retries: { retries: 120, factor: 1, minTimeout: 250, maxTimeout: 250 },
		stale: DOWNLOAD_TIMEOUT_MS * 3,
		update: 10_000,
	});
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
	if (await currentReleaseResourcesAreValid(installDirectory, version)) return false;
	const releaseLock = await lockInstallMutation(installDirectory);
	try {
		if (await currentReleaseResourcesAreValid(installDirectory, version)) return false;
		if (options.offline) {
			throw new Error(
				`Magenta ${version} runtime resources are missing or version-mismatched, and --offline prevents repair. Start Magenta once with network access to repair the installation.`,
			);
		}

		const operationId = randomUUID().replaceAll("-", "");
		const stagingDirectory = join(installDirectory, `.magenta-resource-staging-${operationId}`);
		const backupDirectory = join(installDirectory, `.magenta-resource-backup-${operationId}`);
		const checksumsPath = join(stagingDirectory, RELEASE_CHECKSUMS_ASSET_NAME);
		const resourcesPath = join(stagingDirectory, RELEASE_RESOURCES_ASSET_NAME);
		const assetBaseUrl =
			options.assetBaseUrl?.replace(/\/$/, "") ?? `https://github.com/${GITHUB_REPO}/releases/download/v${version}`;

		console.log(`📦 Repairing version-matched Magenta ${version} runtime resources...`);
		try {
			await mkdir(stagingDirectory, { mode: 0o700 });
			await downloadReleaseAsset(
				{
					name: RELEASE_CHECKSUMS_ASSET_NAME,
					downloadUrl: `${assetBaseUrl}/${RELEASE_CHECKSUMS_ASSET_NAME}`,
				},
				checksumsPath,
			);
			await downloadReleaseAsset(
				{
					name: RELEASE_RESOURCES_ASSET_NAME,
					downloadUrl: `${assetBaseUrl}/${RELEASE_RESOURCES_ASSET_NAME}`,
				},
				resourcesPath,
			);

			const checksums = parseReleaseChecksums(await readFile(checksumsPath, "utf8"));
			await verifyReleaseArtifactChecksums(checksums, [{ name: RELEASE_RESOURCES_ASSET_NAME, path: resourcesPath }]);
			const archiveResourceNames = await inspectReleaseResourceArchive(resourcesPath);
			extractReleaseResources(resourcesPath, stagingDirectory);
			await validateExtractedReleaseResources(stagingDirectory, archiveResourceNames, version);
			const resourceNames = [...new Set([...archiveResourceNames, RELEASE_RESOURCE_MARKER_NAME])];
			const cleanupWarnings = await applyResourceUpdateTransaction({
				installDirectory,
				stagingDirectory,
				backupDirectory,
				resourceNames,
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
			await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
	} finally {
		await releaseLock();
	}
}

export async function checkForUpdate(options: { force?: boolean } = {}): Promise<UpdateCheckResult> {
	if (!options.force && !(await shouldCheckForUpdate())) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
		};
	}

	let release: GitHubRelease | null;
	try {
		release = await getLatestRelease();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			updateAvailable: false,
			currentVersion: VERSION,
			error: `Could not fetch latest release: ${message}`,
		};
	}
	await recordUpdateCheck();

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
			console.log(`\n💡 New version v${result.latestVersion} available. Run 'magenta --update' to upgrade.\n`);
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
	const stagingDirectory = join(installDirectory, `.magenta-update-staging-${operationId}`);
	const backupDirectory = join(installDirectory, `.magenta-update-backup-${operationId}`);
	const scriptPath = join(installDirectory, `.magenta-update-${operationId}.ps1`);
	const stagedBinary = join(stagingDirectory, basename(currentBinary));
	const checksumsPath = join(stagingDirectory, RELEASE_CHECKSUMS_ASSET_NAME);
	const resourcesPath = join(stagingDirectory, RELEASE_RESOURCES_ASSET_NAME);
	let windowsHelperOwnsStaging = false;

	console.log(`📦 Downloading Magenta v${checkResult.latestVersion} and runtime resources...`);

	try {
		await mkdir(stagingDirectory, { mode: 0o700 });
		await downloadReleaseAsset(checkResult.releaseAssets.checksums, checksumsPath);
		await downloadReleaseAsset(checkResult.releaseAssets.binary, stagedBinary);
		await downloadReleaseAsset(checkResult.releaseAssets.resources, resourcesPath);

		const checksums = parseReleaseChecksums(await readFile(checksumsPath, "utf8"));
		await verifyReleaseArtifactChecksums(checksums, [
			{ name: checkResult.releaseAssets.binary.name, path: stagedBinary },
			{ name: checkResult.releaseAssets.resources.name, path: resourcesPath },
		]);

		const archiveResourceNames = await inspectReleaseResourceArchive(resourcesPath);
		extractReleaseResources(resourcesPath, stagingDirectory);
		await validateExtractedReleaseResources(stagingDirectory, archiveResourceNames, checkResult.latestVersion);
		const resourceNames = [...new Set([...archiveResourceNames, RELEASE_RESOURCE_MARKER_NAME])];
		if (platform() !== "win32") await chmod(stagedBinary, 0o755);
		assertBinaryVersion(stagedBinary, checkResult.latestVersion, stagingDirectory);
		assertBinaryHelp(stagedBinary, stagingDirectory);

		if (platform() === "win32") {
			await launchWindowsUpdateHelper(
				scriptPath,
				stagingDirectory,
				backupDirectory,
				resourceNames,
				currentBinary,
				checkResult.latestVersion,
			);
			windowsHelperOwnsStaging = true;
			console.log(`✅ Magenta v${checkResult.latestVersion} is verified and ready to install.`);
			console.log("The update will complete automatically after this Magenta process exits.");
			return { success: true, newVersion: checkResult.latestVersion, pending: true };
		}

		const installLock = await lockInstallMutation(installDirectory);
		let cleanupWarnings: string[];
		try {
			const installedVersion = readBinaryVersion(currentBinary, installDirectory);
			if (
				await shouldSkipConcurrentUpdateTransaction(installDirectory, installedVersion, checkResult.latestVersion)
			) {
				console.log(`Another Magenta process already installed v${installedVersion}; skipping this transaction.`);
				return { success: true, newVersion: installedVersion };
			}
			cleanupWarnings = await applyUnixUpdateTransaction({
				currentBinary,
				stagingDirectory,
				backupDirectory,
				resourceNames,
				verifyInstalled: () =>
					assertBinaryVersion(currentBinary, checkResult.latestVersion as string, installDirectory),
			});
		} finally {
			await installLock();
		}
		for (const warning of cleanupWarnings) console.warn(`Update cleanup warning: ${warning}`);

		console.log(`✅ Updated to v${checkResult.latestVersion}`);
		if (checkResult.releaseNotes) console.log(`\nRelease notes:\n${checkResult.releaseNotes}\n`);
		console.log("Please restart Magenta to use the new version.");
		return { success: true, newVersion: checkResult.latestVersion };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (!windowsHelperOwnsStaging) {
			await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
			await rm(scriptPath, { force: true }).catch(() => undefined);
		}
	}
}
