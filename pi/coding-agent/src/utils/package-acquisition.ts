/**
 * Acquisition layer for harness packages from GitHub releases.
 *
 * Resolves `github:owner/repo/Package@version` selectors, downloads the release
 * artifact (.tar.gz + .sha256), verifies checksum, extracts to local cache, and
 * returns the on-disk package root for loadPackageOverlay consumption.
 *
 * Conventions (per MagentaPackages release.yml):
 * - Tag: <Package>-v<version> (e.g. AutOmicScience-v1.0.0)
 * - Artifact: <Pkg>-v<ver>.tar.gz + <Pkg>-v<ver>.tar.gz.sha256
 * - Download: github.com/owner/repo/releases/download/<Pkg>-v<ver>/<Pkg>-v<ver>.tar.gz
 * - Extract to: ~/.magenta/harness-packages/<Package>@<version>/<Package>/
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes for package download

export type PackageAcquisitionResult = {
	/** Absolute path to the extracted package root (contains package.toml). */
	packageRoot: string;
	/** True if package was already cached and verified. */
	cached: boolean;
	/** Diagnostics (warnings/errors). */
	diagnostics: AcquisitionDiagnostic[];
};

export type AcquisitionDiagnostic = {
	type: "error" | "warning" | "info";
	message: string;
	code?: string;
};

export type GitHubPackageSelector = {
	owner: string;
	repo: string;
	package: string;
	version: string;
};

/**
 * Parse a `github:owner/repo/Package@version` selector.
 * Returns undefined if the selector is not a GitHub URL or is malformed.
 */
export function parseGitHubPackageSelector(selector: string): GitHubPackageSelector | undefined {
	const match = /^github:([^/]+)\/([^/]+)\/([^@]+)@(.+)$/.exec(selector);
	if (!match) return undefined;
	const [, owner, repo, pkg, version] = match;
	return { owner: owner!, repo: repo!, package: pkg!, version: version! };
}

/**
 * Get the local cache directory for harness packages.
 * Default: ~/.magenta/harness-packages/
 */
export function getPackageCacheRoot(): string {
	return join(homedir(), ".magenta", "harness-packages");
}

/**
 * Acquire a harness package from a GitHub release. If already cached and
 * verified, returns the cached path immediately. Otherwise downloads, verifies,
 * extracts, and caches.
 */
export async function acquireGitHubPackage(selector: GitHubPackageSelector): Promise<PackageAcquisitionResult> {
	const diagnostics: AcquisitionDiagnostic[] = [];
	const cacheRoot = getPackageCacheRoot();
	const cacheKey = `${selector.package}@${selector.version}`;
	const cacheDir = join(cacheRoot, cacheKey);
	const packageRoot = join(cacheDir, selector.package);

	// Check if package is already cached and valid
	if (existsSync(packageRoot)) {
		const manifestPath = join(packageRoot, "package.toml");
		if (existsSync(manifestPath)) {
			diagnostics.push({ type: "info", message: `Using cached ${cacheKey}` });
			return { packageRoot, cached: true, diagnostics };
		}
		// Cache directory exists but is incomplete; clean and re-download
		diagnostics.push({ type: "warning", message: `Incomplete cache for ${cacheKey}, re-downloading` });
		try {
			rmSync(cacheDir, { recursive: true, force: true });
		} catch (error) {
			diagnostics.push({
				type: "error",
				code: "cache_cleanup_failed",
				message: `Failed to clean incomplete cache: ${error instanceof Error ? error.message : String(error)}`,
			});
			return { packageRoot: cacheDir, cached: false, diagnostics };
		}
	}

	// Download and extract
	try {
		mkdirSync(cacheDir, { recursive: true });
		const tag = `${selector.package}-v${selector.version}`;
		const artifact = `${tag}.tar.gz`;
		const artifactUrl = `https://github.com/${selector.owner}/${selector.repo}/releases/download/${tag}/${artifact}`;
		const checksumUrl = `${artifactUrl}.sha256`;

		const tempDir = join(cacheDir, ".download");
		mkdirSync(tempDir, { recursive: true });
		const tarballPath = join(tempDir, artifact);
		const checksumPath = join(tempDir, `${artifact}.sha256`);

		// Download tarball
		diagnostics.push({ type: "info", message: `Downloading ${selector.package} v${selector.version}...` });
		await downloadFile(artifactUrl, tarballPath);

		// Download checksum
		await downloadFile(checksumUrl, checksumPath);

		// Verify checksum
		const checksumContent = await readFile(checksumPath, "utf-8");
		const [expectedHash] = checksumContent.trim().split(/\s+/);
		if (!expectedHash) {
			throw new Error(`Invalid checksum file format`);
		}

		const actualHash = await computeSHA256(tarballPath);
		if (actualHash !== expectedHash) {
			throw new Error(`SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`);
		}
		diagnostics.push({ type: "info", message: `Checksum verified` });

		// Extract tarball
		extractTarGz(tarballPath, cacheDir);

		// Clean up temp files
		rmSync(tempDir, { recursive: true, force: true });

		// Verify extraction
		if (!existsSync(packageRoot) || !existsSync(join(packageRoot, "package.toml"))) {
			throw new Error(`Extraction incomplete: package.toml not found in ${packageRoot}`);
		}

		diagnostics.push({ type: "info", message: `Installed ${cacheKey}` });
		return { packageRoot, cached: false, diagnostics };
	} catch (error) {
		// Clean up partial download on failure
		try {
			rmSync(cacheDir, { recursive: true, force: true });
		} catch {}
		diagnostics.push({
			type: "error",
			code: "acquisition_failed",
			message: `Failed to acquire ${cacheKey}: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { packageRoot: cacheDir, cached: false, diagnostics };
	}
}

/**
 * Download a file from a URL with timeout and progress. Throws on HTTP errors.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "Magenta-Package-Acquisition" },
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error("Response body is empty");
		}

		const fileStream = createWriteStream(dest);
		await pipeline(Readable.fromWeb(response.body as any), fileStream);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Compute SHA256 hash of a file (hex string).
 */
async function computeSHA256(filePath: string): Promise<string> {
	const content = await readFile(filePath);
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Extract a .tar.gz archive using the system `tar` command.
 * Extracted contents are placed directly under extractDir.
 */
function extractTarGz(tarballPath: string, extractDir: string): void {
	const tarCommand = platform() === "win32" ? getWindowsTarCommand() : "tar";
	const result = spawnSync(tarCommand, ["xzf", tarballPath, "-C", extractDir], { stdio: "pipe" });

	if (result.error) {
		throw new Error(`Failed to spawn tar: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr?.toString() || "(no output)";
		throw new Error(`tar extraction failed (exit ${result.status}): ${stderr}`);
	}
}

/**
 * On Windows, prefer System32 tar.exe (bsdtar) for consistency, then fall back
 * to PATH lookup. bsdtar ships with Windows 10/11 by default.
 */
function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot || "C:\\Windows";
	const systemTar = join(systemRoot, "System32", "tar.exe");
	if (existsSync(systemTar)) return systemTar;
	return "tar.exe";
}
