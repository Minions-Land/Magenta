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
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { VERSION, isBunBinary } from "../config.ts";

// ============================================================================
// Configuration - Set these before building the binary
// ============================================================================

/** GitHub repository in format "owner/repo" */
const GITHUB_REPO = process.env.MAGENTA_GITHUB_REPO || "Minions-Land/Magenta-CLI";

/** 
 * GitHub Personal Access Token (optional).
 * For public repositories, no token is needed - downloads work anonymously.
 * Set MAGENTA_GITHUB_TOKEN environment variable only if using a private repo.
 */
const GITHUB_TOKEN = process.env.MAGENTA_GITHUB_TOKEN || "";

/** Check for updates at most once per day */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Timeout for network requests */
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes for binary downloads

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

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
	try {
		const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
		const response = await fetchWithTimeout(url, {
			headers: buildGitHubHeaders("application/vnd.github+json"),
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

/**
 * Resolve the release asset name for the current platform + architecture.
 * Naming must match the assets produced by `npm run build:release-all`:
 *   magenta-macos-arm64, magenta-macos-x64,
 *   magenta-linux-x64, magenta-windows-x64.exe
 */
function getBinaryAssetName(): string {
	const plat = platform();
	const a = arch(); // "arm64" | "x64" | ...
	if (plat === "darwin") return a === "arm64" ? "magenta-macos-arm64" : "magenta-macos-x64";
	if (plat === "linux") return "magenta-linux-x64";
	if (plat === "win32") return "magenta-windows-x64.exe";
	return "magenta";
}

/**
 * Build GitHub request headers. Includes Authorization only when a token is
 * configured (private repos). Public repos download anonymously.
 */
function buildGitHubHeaders(accept: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: accept,
		"User-Agent": "Magenta-Auto-Update",
	};
	if (GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
	}
	return headers;
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
			// Public repo: anonymous download via browser_download_url
			downloadUrl: asset.browser_download_url,
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
	// Safety guard: self-update only works for the compiled single-file binary.
	// When running via Node.js (e.g. `node dist/cli.js`), process.execPath points
	// to the Node.js executable itself — overwriting it would corrupt the host
	// Node.js installation. Refuse to update in that case.
	if (!isBunBinary) {
		return {
			success: false,
			error:
				"自更新仅适用于编译后的 Magenta 二进制文件。当前通过 Node.js 运行，跳过自更新以避免覆盖 Node.js。",
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
		// Download the new binary (use longer timeout for large files)
		const response = await fetchWithTimeout(checkResult.downloadUrl, {
			headers: buildGitHubHeaders("application/octet-stream"),
		}, DOWNLOAD_TIMEOUT_MS);

		if (!response.ok) {
			throw new Error(`Download failed: ${response.status} ${response.statusText}`);
		}

		// Get the path to the currently running binary
		const currentBinary = process.execPath;
		const backupPath = `${currentBinary}.backup`;
		const tempPath = `${currentBinary}.new`;

		// Save downloaded binary to temp location
		if (!response.body) {
			throw new Error("Response body is null");
		}
		
		const fileStream = createWriteStream(tempPath);
		
		// Convert Web ReadableStream to Node.js stream and add progress
		const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
		let downloadedBytes = 0;
		const startTime = Date.now();
		
		const reader = response.body.getReader();
		const writeChunk = async (): Promise<void> => {
			const { done, value } = await reader.read();
			if (done) {
				fileStream.end();
				return;
			}
			
			if (contentLength > 0) {
				downloadedBytes += value.length;
				const percent = Math.floor((downloadedBytes / contentLength) * 100);
				const elapsed = Math.max(1, (Date.now() - startTime) / 1000);
				const speed = (downloadedBytes / elapsed / 1024 / 1024).toFixed(2);
				process.stdout.write(`\r📥 下载中: ${percent}% (${speed} MB/s)`);
			}
			
			fileStream.write(value);
			await writeChunk();
		};
		
		await writeChunk();
		if (contentLength > 0) {
			console.log(""); // New line after progress
		}
		
		// Wait for stream to finish
		await new Promise<void>((resolve, reject) => {
			fileStream.on("finish", resolve);
			fileStream.on("error", reject);
		});

		// Make it executable (Unix only, no-op on Windows)
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

		// Windows: cannot rename a running .exe. Generate a batch script to do it after exit.
		if (platform() === "win32") {
			return await installUpdateWindows(tempPath, currentBinary, backupPath, checkResult);
		}

		// Unix: atomic rename (backup old → install new)
		if (existsSync(backupPath)) {
			await unlink(backupPath);
		}
		await rename(currentBinary, backupPath);
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

/**
 * Windows-specific update installer.
 * 
 * Windows cannot rename a running .exe, so we:
 *  1. Write the new binary to a temp location
 *  2. Generate a batch script to replace the exe after magenta exits
 *  3. Launch the batch script in detached mode
 *  4. Instruct the user to exit magenta
 */
async function installUpdateWindows(
	tempPath: string,
	currentBinary: string,
	backupPath: string,
	checkResult: UpdateCheckResult,
): Promise<UpdateInstallResult> {
	const batchScript = `${currentBinary}.update.bat`;

	// Generate a batch script that:
	//  - Waits for magenta.exe to exit (loop checking process list)
	//  - Backs up the old exe
	//  - Copies new exe into place
	//  - Cleans up temp files
	const batchContent = `@echo off
echo Waiting for Magenta to exit...
:wait
tasklist /FI "IMAGENAME eq ${basename(currentBinary)}" 2>NUL | find /I /N "${basename(currentBinary)}">NUL
if "%ERRORLEVEL%"=="0" (
  timeout /t 1 /nobreak >NUL
  goto wait
)

echo Updating Magenta to v${checkResult.latestVersion}...
if exist "${backupPath}" del /f "${backupPath}"
if exist "${currentBinary}" ren "${currentBinary}" "${basename(backupPath)}"
move /y "${tempPath}" "${currentBinary}" >NUL
if exist "${tempPath}" del /f "${tempPath}"

echo Update complete. You can restart magenta.exe now.
timeout /t 3 /nobreak >NUL
del /f "%~f0"
`;

	try {
		await writeFile(batchScript, batchContent, "utf8");

		// Launch the batch script in detached mode so it survives magenta's exit
		const child = spawn("cmd.exe", ["/c", batchScript], {
			detached: true,
			stdio: "ignore",
		});
		// Unref so the parent (magenta) can exit without waiting for the updater
		child.unref();

		console.log(`✅ 已下载 Magenta v${checkResult.latestVersion}`);
		if (checkResult.releaseNotes) {
			console.log(`\n更新内容:\n${checkResult.releaseNotes}\n`);
		}
		console.log(
			`⚠️  Windows 更新需要退出当前进程。\n` +
				`   更新脚本已在后台启动，请关闭此窗口或按 Ctrl+C 退出。\n` +
				`   退出后，更新将自动完成（旧版本备份为 ${basename(backupPath)}）。`,
		);

		return {
			success: true,
			newVersion: checkResult.latestVersion,
		};
	} catch (error) {
		// Clean up batch script if spawn failed
		if (existsSync(batchScript)) {
			await unlink(batchScript);
		}
		throw error;
	}
}
