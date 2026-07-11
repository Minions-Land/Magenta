/**
 * GitHub Releases-based auto-update mechanism for Magenta.
 * 
 * This module checks GitHub Releases for new versions and downloads the binary
 * when updates are available. The GitHub token is compiled into the binary to
 * allow access to private repository releases without exposing source code.
 * 
 * Unlike magenta-update.ts (git-based), this works with distributed binaries.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { VERSION } from "../config.ts";

// ============================================================================
// Configuration - Set these before building the binary
// ============================================================================

/** GitHub repository in format "owner/repo" */
const GITHUB_REPO = process.env.MAGENTA_GITHUB_REPO || "Minions-Land/Magenta";

/** 
 * GitHub Personal Access Token with public_repo scope.
 * This token is embedded in the binary to allow downloading releases
 * from a private repository without giving users source code access.
 */
const GITHUB_TOKEN = process.env.MAGENTA_GITHUB_TOKEN || "***REMOVED***";

/** Check for updates at most once per day */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Timeout for network requests */
const FETCH_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

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
	/** Human-readable reason when check fails */
	error?: string;
}

export interface UpdateInstallResult {
	success: boolean;
	newVersion?: string;
	/** Human-readable reason when installation fails */
	error?: string;
}

// ============================================================================
// Version Comparison
// ============================================================================

/**
 * Compare two semantic version strings.
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
	const normalize = (v: string) => v.replace(/^v/, "").split(".").map(Number);
	const parts1 = normalize(v1);
	const parts2 = normalize(v2);

	for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
		const a = parts1[i] || 0;
		const b = parts2[i] || 0;
		if (a !== b) return a - b;
	}
	return 0;
}

// ============================================================================
// Update Check Tracking
// ============================================================================

function getLastCheckFile(): string {
	return join(homedir(), ".magenta", "last-update-check");
}

async function shouldCheckForUpdate(): Promise<boolean> {
	const checkFile = getLastCheckFile();
	if (!existsSync(checkFile)) return true;

	try {
		const lastCheck = Number.parseInt(await readFile(checkFile, "utf8"));
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

// ============================================================================
// GitHub API
// ============================================================================

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
		});
		return response;
	} finally {
		clearTimeout(timeout);
	}
}

async function getLatestRelease(): Promise<GitHubRelease | null> {
	if (!GITHUB_TOKEN) {
		return null;
	}

	try {
		const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
		const response = await fetchWithTimeout(url, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${GITHUB_TOKEN}`,
				"User-Agent": "Magenta-Auto-Update",
			},
		});

		if (!response.ok) {
			if (response.status === 404) {
				// No releases published yet
				return null;
			}
			throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
		}

		return await response.json() as GitHubRelease;
	} catch (error) {
		// Network errors, timeouts, etc. - silently fail
		return null;
	}
}

function getBinaryAssetName(): string {
	const plat = platform();
	if (plat === "darwin") return "magenta-macos";
	if (plat === "linux") return "magenta-linux";
	if (plat === "win32") return "magenta-windows.exe";
	return "magenta";
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a new version is available on GitHub Releases.
 * This is a lightweight check that respects the daily check interval.
 */
export async function checkForUpdate(options: { force?: boolean } = {}): Promise<UpdateCheckResult> {
	// Respect check interval unless forced
	if (!options.force && !(await shouldCheckForUpdate())) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
		};
	}

	// Require GitHub token
	if (!GITHUB_TOKEN) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
			error: "GitHub token not configured",
		};
	}

	const release = await getLatestRelease();
	await recordUpdateCheck();

	if (!release) {
		return {
			updateAvailable: false,
			currentVersion: VERSION,
			error: "Could not fetch latest release",
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

	// Find the binary asset for current platform
	const assetName = getBinaryAssetName();
	const asset = release.assets.find((a) => a.name === assetName);

	if (!asset) {
		return {
			updateAvailable: true,
			currentVersion: VERSION,
			latestVersion,
			error: `No binary found for ${platform()} (expected asset: ${assetName})`,
		};
	}

		return {
			updateAvailable: true,
			currentVersion: VERSION,
			latestVersion,
			releaseNotes: release.body,
			// For private repos, use API endpoint instead of browser_download_url
			downloadUrl: asset.url,
		};
}

/**
 * Background check that prints a notification if an update is available.
 * Non-blocking, never throws, suitable for calling at startup.
 */
export async function backgroundUpdateNotification(): Promise<void> {
	try {
		const result = await checkForUpdate();
		if (result.updateAvailable && result.latestVersion) {
			console.log(`\n💡 新版本 v${result.latestVersion} 可用，运行 'magenta --update' 升级\n`);
		}
	} catch {
		// Silent failure - don't interrupt the user
	}
}

/**
 * Download and install the latest version from GitHub Releases.
 * This replaces the current binary with the new one.
 */
export async function installUpdate(): Promise<UpdateInstallResult> {
	if (!GITHUB_TOKEN) {
		return {
			success: false,
			error: "GitHub token not configured",
		};
	}

	// Force check for latest version
	const checkResult = await checkForUpdate({ force: true });

	if (checkResult.error) {
		return {
			success: false,
			error: checkResult.error,
		};
	}

	if (!checkResult.updateAvailable) {
		return {
			success: false,
			error: `Already on latest version (${VERSION})`,
		};
	}

	if (!checkResult.downloadUrl || !checkResult.latestVersion) {
		return {
			success: false,
			error: "Update information incomplete",
		};
	}

	console.log(`📦 正在下载 Magenta v${checkResult.latestVersion}...`);

	try {
		// Download the new binary
		const response = await fetchWithTimeout(checkResult.downloadUrl, {
			headers: {
				Accept: "application/octet-stream",
				Authorization: `Bearer ${GITHUB_TOKEN}`,
				"User-Agent": "Magenta-Auto-Update",
			},
		});

		if (!response.ok) {
			throw new Error(`Download failed: ${response.status} ${response.statusText}`);
		}

		// Get the path to the currently running binary
		const currentBinary = process.execPath;
		const backupPath = `${currentBinary}.backup`;
		const tempPath = `${currentBinary}.new`;

		// Save downloaded binary to temp location
		const fileStream = createWriteStream(tempPath);
		if (!response.body) {
			throw new Error("Response body is null");
		}
		await pipeline(response.body as any, fileStream);

		// Make it executable
		await chmod(tempPath, 0o755);

		// Test that the new binary works
		const testResult = spawnSync(tempPath, ["--version"], {
			encoding: "utf8",
			timeout: 5000,
		});

		if (testResult.status !== 0) {
			await unlink(tempPath);
			throw new Error("Downloaded binary failed verification");
		}

		// Backup current version
		if (existsSync(backupPath)) {
			await unlink(backupPath);
		}
		await rename(currentBinary, backupPath);

		// Install new version
		await rename(tempPath, currentBinary);

		console.log(`✅ 已更新到 v${checkResult.latestVersion}`);
		if (checkResult.releaseNotes) {
			console.log(`\n更新内容:\n${checkResult.releaseNotes}\n`);
		}
		console.log(`旧版本已备份为 ${basename(backupPath)}`);
		console.log("\n请重新启动 magenta 使用新版本");

		return {
			success: true,
			newVersion: checkResult.latestVersion,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
