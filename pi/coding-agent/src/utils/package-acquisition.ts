/**
 * Acquisition layer for harness packages from GitHub releases.
 *
 * Resolves `github:owner/repo/Package@version` selectors, downloads the release
 * artifact (.tar.gz + .sha256), verifies checksum, extracts to local cache, and
 * returns the on-disk package root for HcpClientloadpackageoverlay consumption.
 *
 * Conventions (per MagentaPackages release.yml):
 * - Tag: <Package>-v<version> (e.g. AutOmicScience-v1.0.0)
 * - Artifact: <Pkg>-v<ver>-<platform>.tar.gz + .sha256
 * - Download: github.com/owner/repo/releases/download/<Pkg>-v<ver>/<artifact>
 * - Extract to: ~/.magenta/harness-packages/github/<owner>/<repo>/<Package>@<version>/<platform>/<Package>/
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import lockfile from "proper-lockfile";
import { valid as validSemver } from "semver";
import { parse as parseToml } from "smol-toml";

const HcpClientpackagedownloadtimeoutms = 300_000; // 5 minutes for package download
const HcpClientpackagecacheprovenancefile = ".magenta-package-provenance.json";
const HcpClientpackagecacheprovenanceschemaversion = 2;
const HcpClientgithubownerpattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const HcpClientgithubrepopattern = /^[A-Za-z0-9._-]{1,100}$/;
const HcpClientpackagenamepattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HcpClientwindowsreservednamepattern = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const HcpClientstrictsemverpattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HcpClientinflightpackageacquisitions = new Map<string, Promise<HcpClientpackageacquisitionresult>>();

export type HcpClientpackageacquisitionresult = {
	/** Absolute path to the extracted package root (contains package.toml). */
	packageRoot: string;
	/** True if package was already cached and verified. */
	cached: boolean;
	/** Diagnostics (warnings/errors). */
	diagnostics: HcpClientpackageacquisitiondiagnostic[];
};

export type HcpClientpackageacquisitiondiagnostic = {
	type: "error" | "warning" | "info";
	message: string;
	code?: string;
};

export type HcpClientgithubpackageselector = {
	owner: string;
	repo: string;
	package: string;
	version: string;
	profiles?: string[];
};

export type HcpClientpackageplatformid = "linux-x64" | "macos-arm64" | "macos-x64" | "windows-x64";

/** Platform suffix shared by MagentaPackages release assets and the local cache. */
export function HcpClientgetpackageplatformid(): HcpClientpackageplatformid {
	const hostPlatform = platform();
	const hostArch = arch();
	if (hostPlatform === "darwin" && hostArch === "arm64") return "macos-arm64";
	if (hostPlatform === "darwin" && hostArch === "x64") return "macos-x64";
	if (hostPlatform === "linux" && hostArch === "x64") return "linux-x64";
	if (hostPlatform === "win32" && hostArch === "x64") return "windows-x64";
	throw new Error(`Unsupported package platform: ${hostPlatform}-${hostArch}`);
}

type HcpClientpackagecacheprovenance = {
	schemaVersion: number;
	source: "github";
	owner: string;
	repo: string;
	package: string;
	version: string;
	platform: HcpClientpackageplatformid;
	artifact: string;
	artifactSha256: string;
};

type HcpClientpackagecachepathset = {
	cacheRoot: string;
	cacheDir: string;
	packageRoot: string;
	provenancePath: string;
	lockPath: string;
	platform: HcpClientpackageplatformid;
};

/**
 * Parse a `github:owner/repo/Package@version[:profile1,profile2]` selector.
 * Returns undefined if the selector is not a GitHub URL or is malformed.
 */
export function HcpClientparsegithubpackageselector(selector: string): HcpClientgithubpackageselector | undefined {
	const match = /^github:([^/]+)\/([^/]+)\/([^/@]+)@([^:]+)(?::(.+))?$/.exec(selector);
	if (!match) return undefined;
	const [, owner, repo, pkg, version, profileList] = match;
	const profiles = profileList
		?.split(",")
		.map((profile) => profile.trim())
		.filter(Boolean);
	const parsed = {
		owner: owner!,
		repo: repo!,
		package: pkg!,
		version: version!,
		...(profiles && profiles.length > 0 ? { profiles } : {}),
	};
	return HcpClientvalidategithubpackageselector(parsed) === undefined ? parsed : undefined;
}

/**
 * Get the local cache directory for harness packages.
 * Default: ~/.magenta/harness-packages/
 */
export function HcpClientgetpackagecacheroot(): string {
	return join(homedir(), ".magenta", "harness-packages");
}

/**
 * Acquire a harness package from a GitHub release. If already cached and
 * verified, returns the cached path immediately. Otherwise downloads, verifies,
 * extracts, and caches.
 */
export async function HcpClientacquiregithubpackage(
	selector: HcpClientgithubpackageselector,
): Promise<HcpClientpackageacquisitionresult> {
	const selectorError = HcpClientvalidategithubpackageselector(selector);
	if (selectorError) {
		return {
			packageRoot: HcpClientgetpackagecacheroot(),
			cached: false,
			diagnostics: [
				{
					type: "error",
					code: "package_selector_invalid",
					message: `Invalid GitHub package selector: ${selectorError}`,
				},
			],
		};
	}

	let paths: HcpClientpackagecachepathset;
	try {
		paths = HcpClientresolvepackagecachepaths(selector);
	} catch (error) {
		return {
			packageRoot: HcpClientgetpackagecacheroot(),
			cached: false,
			diagnostics: [
				{
					type: "error",
					code: "package_cache_path_invalid",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}

	const existing = HcpClientinflightpackageacquisitions.get(paths.cacheDir);
	if (existing) return existing;
	const acquisition = HcpClientacquiregithubpackageunshared(selector, paths);
	HcpClientinflightpackageacquisitions.set(paths.cacheDir, acquisition);
	try {
		return await acquisition;
	} finally {
		if (HcpClientinflightpackageacquisitions.get(paths.cacheDir) === acquisition) {
			HcpClientinflightpackageacquisitions.delete(paths.cacheDir);
		}
	}
}

async function HcpClientacquiregithubpackageunshared(
	selector: HcpClientgithubpackageselector,
	paths: HcpClientpackagecachepathset,
): Promise<HcpClientpackageacquisitionresult> {
	let release: (() => Promise<void>) | undefined;
	try {
		release = await HcpClientlockpackagecache(paths);
		return await HcpClientacquiregithubpackagelocked(selector, paths);
	} catch (error) {
		const lockAcquired = release !== undefined;
		return {
			packageRoot: paths.packageRoot,
			cached: false,
			diagnostics: [
				{
					type: "error",
					code: lockAcquired ? "acquisition_failed" : "package_cache_lock_failed",
					message: `${lockAcquired ? "Package acquisition failed" : "Failed to lock package cache"}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				},
			],
		};
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// The cache operation already completed; a compromised lock is reported by the lock owner.
			}
		}
	}
}

async function HcpClientacquiregithubpackagelocked(
	selector: HcpClientgithubpackageselector,
	paths: HcpClientpackagecachepathset,
): Promise<HcpClientpackageacquisitionresult> {
	const diagnostics: HcpClientpackageacquisitiondiagnostic[] = [];
	const { cacheRoot, cacheDir, packageRoot, platform: packagePlatform } = paths;
	const cacheKey = `${selector.owner}/${selector.repo}/${selector.package}@${selector.version}/${packagePlatform}`;

	// Check if package is already cached and valid
	if (existsSync(cacheDir)) {
		const invalidReason = await HcpClientvalidatecachedpackage(paths, selector);
		if (!invalidReason) {
			diagnostics.push({ type: "info", message: `Using cached ${cacheKey}` });
			return { packageRoot, cached: true, diagnostics };
		}
		// Cache directory exists but is incomplete, corrupt, or belongs to another
		// origin. Remove only the already-contained cache directory.
		diagnostics.push({
			type: "warning",
			message: `Invalid cache for ${cacheKey} (${invalidReason}), re-downloading`,
		});
		try {
			HcpClientremovecachedir(cacheRoot, cacheDir);
		} catch (error) {
			diagnostics.push({
				type: "error",
				code: "cache_cleanup_failed",
				message: `Failed to clean incomplete cache: ${error instanceof Error ? error.message : String(error)}`,
			});
			return { packageRoot, cached: false, diagnostics };
		}
	}

	const stagingDir = HcpClientpackagestagingdir(paths);
	const stagingPackageRoot = join(stagingDir, selector.package);
	const stagingProvenancePath = join(stagingDir, HcpClientpackagecacheprovenancefile);

	// Download and extract in a unique sibling staging directory. The final cache
	// path does not exist until the fully validated tree is atomically renamed.
	try {
		mkdirSync(dirname(cacheDir), { recursive: true });
		mkdirSync(stagingDir);
		const tag = `${selector.package}-v${selector.version}`;
		const artifact = `${tag}-${packagePlatform}.tar.gz`;
		const artifactUrl = `https://github.com/${encodeURIComponent(selector.owner)}/${encodeURIComponent(selector.repo)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact)}`;
		const checksumUrl = `${artifactUrl}.sha256`;

		const tempDir = join(stagingDir, ".download");
		mkdirSync(tempDir, { recursive: true });
		const tarballPath = join(tempDir, artifact);
		const checksumPath = join(tempDir, `${artifact}.sha256`);

		// Download tarball
		diagnostics.push({ type: "info", message: `Downloading ${selector.package} v${selector.version}...` });
		await HcpClientdownloadpackagefile(artifactUrl, tarballPath);

		// Download checksum
		await HcpClientdownloadpackagefile(checksumUrl, checksumPath);

		// Verify checksum
		const checksumContent = await readFile(checksumPath, "utf-8");
		const [expectedHash] = checksumContent.trim().split(/\s+/);
		if (!expectedHash || !/^[a-fA-F0-9]{64}$/.test(expectedHash)) {
			throw new Error(`Invalid checksum file format`);
		}

		const actualHash = await HcpClientcomputepackagesha256(tarballPath);
		if (actualHash !== expectedHash.toLowerCase()) {
			throw new Error(`SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`);
		}
		diagnostics.push({ type: "info", message: `Checksum verified` });

		// Inspect all logical entries before extraction. Only regular files and
		// directories beneath the one expected package root are accepted.
		HcpClientvalidatetargzarchive(tarballPath, selector.package);
		HcpClientextracttargz(tarballPath, stagingDir);

		// Clean up temp files
		rmSync(tempDir, { recursive: true, force: true });

		// Validate the extracted manifest before marking the cache usable. The
		// provenance file is written last, so an interrupted install is never
		// accepted as a verified cache entry on the next launch.
		await HcpClientvalidatepackagemanifest(stagingPackageRoot, selector);
		const provenance: HcpClientpackagecacheprovenance = {
			schemaVersion: HcpClientpackagecacheprovenanceschemaversion,
			source: "github",
			owner: selector.owner.toLowerCase(),
			repo: selector.repo.toLowerCase(),
			package: selector.package,
			version: selector.version,
			platform: packagePlatform,
			artifact,
			artifactSha256: actualHash,
		};
		await writeFile(stagingProvenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf-8");

		const published = await HcpClientpublishstagedcache(stagingDir, paths, selector);
		if (!published) {
			diagnostics.push({ type: "info", message: `Another process installed ${cacheKey}` });
			return { packageRoot, cached: true, diagnostics };
		}

		diagnostics.push({ type: "info", message: `Installed ${cacheKey}` });
		return { packageRoot, cached: false, diagnostics };
	} catch (error) {
		// Clean only this acquisition's staging directory. A concurrent process may
		// already have published a valid final cache entry, which must be preserved.
		try {
			HcpClientremovecachedir(cacheRoot, stagingDir);
		} catch {}
		diagnostics.push({
			type: "error",
			code: "acquisition_failed",
			message: `Failed to acquire ${cacheKey}: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { packageRoot, cached: false, diagnostics };
	}
}

async function HcpClientlockpackagecache(paths: HcpClientpackagecachepathset): Promise<() => Promise<void>> {
	mkdirSync(dirname(paths.lockPath), { recursive: true });
	await writeFile(paths.lockPath, "", { flag: "a" });
	return lockfile.lock(paths.lockPath, {
		realpath: false,
		retries: {
			retries: 120,
			factor: 1.2,
			minTimeout: 100,
			maxTimeout: 5000,
			randomize: true,
		},
		stale: HcpClientpackagedownloadtimeoutms * 3,
		update: 30_000,
	});
}

function HcpClientvalidategithubpackageselector(selector: HcpClientgithubpackageselector): string | undefined {
	if (!selector || typeof selector !== "object") return "selector must be an object";
	if (typeof selector.owner !== "string") return "owner must be a string";
	if (typeof selector.repo !== "string") return "repository must be a string";
	if (typeof selector.package !== "string") return "package must be a string";
	if (typeof selector.version !== "string") return "version must be a string";
	if (
		selector.profiles !== undefined &&
		(!Array.isArray(selector.profiles) || selector.profiles.some((profile) => typeof profile !== "string"))
	) {
		return "profiles must be an array of strings";
	}
	if (!HcpClientisportablepathsegment(selector.owner, HcpClientgithubownerpattern)) {
		return "owner must be a valid GitHub account name";
	}
	if (!HcpClientissafereponame(selector.repo)) {
		return "repository must contain only letters, digits, '.', '_', or '-'";
	}
	if (!HcpClientissafepackagename(selector.package)) {
		return "package must be one safe path segment";
	}
	if (!HcpClientstrictsemverpattern.test(selector.version) || validSemver(selector.version) === null) {
		return "version must be a strict semantic version";
	}
	const invalidProfile = selector.profiles?.find(
		(profile) =>
			profile !== "*" && profile !== "all" && !HcpClientisportablepathsegment(profile, HcpClientpackagenamepattern),
	);
	if (invalidProfile) return `profile must be a portable identifier: ${invalidProfile}`;
	return undefined;
}

function HcpClientissafereponame(value: string): boolean {
	return HcpClientisportablepathsegment(value, HcpClientgithubrepopattern);
}

function HcpClientissafepackagename(value: string): boolean {
	return HcpClientisportablepathsegment(value, HcpClientpackagenamepattern);
}

function HcpClientisportablepathsegment(value: string, pattern: RegExp): boolean {
	return (
		pattern.test(value) &&
		value !== "." &&
		value !== ".." &&
		!value.endsWith(".") &&
		!HcpClientwindowsreservednamepattern.test(value)
	);
}

function HcpClientresolvepackagecachepaths(selector: HcpClientgithubpackageselector): HcpClientpackagecachepathset {
	const cacheRoot = resolve(HcpClientgetpackagecacheroot());
	const packagePlatform = HcpClientgetpackageplatformid();
	const cacheDir = resolve(
		cacheRoot,
		"github",
		selector.owner.toLowerCase(),
		selector.repo.toLowerCase(),
		`${selector.package}@${selector.version}`,
		packagePlatform,
	);
	HcpClientassertpathwithin(cacheRoot, cacheDir, "package cache directory");
	const packageRoot = resolve(cacheDir, selector.package);
	HcpClientassertpathwithin(cacheDir, packageRoot, "extracted package root");
	return {
		cacheRoot,
		cacheDir,
		packageRoot,
		provenancePath: join(cacheDir, HcpClientpackagecacheprovenancefile),
		lockPath: join(dirname(cacheDir), `.${basename(cacheDir)}.acquire`),
		platform: packagePlatform,
	};
}

function HcpClientpackagestagingdir(paths: HcpClientpackagecachepathset): string {
	const stagingDir = resolve(
		dirname(paths.cacheDir),
		`.${basename(paths.cacheDir)}.staging-${process.pid}-${randomUUID()}`,
	);
	HcpClientassertpathwithin(paths.cacheRoot, stagingDir, "package staging directory");
	return stagingDir;
}

function HcpClientassertpathwithin(parent: string, child: string, description: string): void {
	const rel = relative(parent, child);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`${description} escapes its parent directory`);
	}
}

function HcpClientremovecachedir(cacheRoot: string, cacheDir: string): void {
	HcpClientassertpathwithin(cacheRoot, cacheDir, "package cache directory");
	rmSync(cacheDir, { recursive: true, force: true });
}

async function HcpClientpublishstagedcache(
	stagingDir: string,
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
): Promise<boolean> {
	try {
		await rename(stagingDir, paths.cacheDir);
		return true;
	} catch (error) {
		if (!existsSync(paths.cacheDir)) throw error;
		const invalidReason = await HcpClientvalidatecachedpackage(paths, selector);
		if (invalidReason) {
			throw new Error(`cache destination appeared during publication but is invalid: ${invalidReason}`);
		}
		HcpClientremovecachedir(paths.cacheRoot, stagingDir);
		return false;
	}
}

async function HcpClientvalidatecachedpackage(
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
): Promise<string | undefined> {
	try {
		const cacheInfo = await lstat(paths.cacheDir);
		if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
			return `cache entry is not a real directory: ${paths.cacheDir}`;
		}
		const provenanceInfo = await lstat(paths.provenancePath);
		if (!provenanceInfo.isFile() || provenanceInfo.isSymbolicLink()) {
			return `cache provenance is not a real file: ${paths.provenancePath}`;
		}
		const [actualCacheRoot, actualCacheDir, actualPackageRoot] = await Promise.all([
			realpath(paths.cacheRoot),
			realpath(paths.cacheDir),
			realpath(paths.packageRoot),
		]);
		HcpClientassertpathwithin(actualCacheRoot, actualCacheDir, "package cache directory");
		HcpClientassertpathwithin(actualCacheDir, actualPackageRoot, "cached package root");
		const provenanceRaw = await readFile(paths.provenancePath, "utf-8");
		const provenance = JSON.parse(provenanceRaw) as Partial<HcpClientpackagecacheprovenance>;
		if (
			provenance.schemaVersion !== HcpClientpackagecacheprovenanceschemaversion ||
			provenance.source !== "github" ||
			provenance.owner !== selector.owner.toLowerCase() ||
			provenance.repo !== selector.repo.toLowerCase() ||
			provenance.package !== selector.package ||
			provenance.version !== selector.version ||
			provenance.platform !== paths.platform ||
			provenance.artifact !== `${selector.package}-v${selector.version}-${paths.platform}.tar.gz` ||
			typeof provenance.artifactSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(provenance.artifactSha256)
		) {
			return "provenance does not match the requested origin";
		}
		await HcpClientvalidatepackagemanifest(paths.packageRoot, selector);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function HcpClientvalidatepackagemanifest(
	packageRoot: string,
	selector: HcpClientgithubpackageselector,
): Promise<void> {
	const packageInfo = await lstat(packageRoot);
	if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
		throw new Error(`extracted package root is not a real directory: ${packageRoot}`);
	}
	const manifestPath = join(packageRoot, "package.toml");
	const manifestInfo = await lstat(manifestPath);
	if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
		throw new Error(`package.toml is not a real file: ${manifestPath}`);
	}
	const manifest = parseToml(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
	if (manifest.schema_version !== "magenta.package.v2") {
		throw new Error(`package.toml must declare schema_version = "magenta.package.v2"`);
	}
	if (manifest.id !== selector.package) {
		throw new Error(`package.toml id ${JSON.stringify(manifest.id)} does not match ${selector.package}`);
	}
	if (manifest.version !== selector.version) {
		throw new Error(`package.toml version ${JSON.stringify(manifest.version)} does not match ${selector.version}`);
	}
	if (typeof manifest.name !== "string" || manifest.name.length === 0) {
		throw new Error(`package.toml must declare a non-empty name`);
	}
	if (typeof manifest.source !== "string" || manifest.source.length === 0) {
		throw new Error(`package.toml must declare a non-empty source`);
	}
}

/**
 * Download a file from a URL with timeout and progress. Throws on HTTP errors.
 */
async function HcpClientdownloadpackagefile(url: string, dest: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HcpClientpackagedownloadtimeoutms);

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
async function HcpClientcomputepackagesha256(filePath: string): Promise<string> {
	const content = await readFile(filePath);
	return createHash("sha256").update(content).digest("hex");
}

/** Reject tar-slip paths and every entry type except regular files/directories. */
function HcpClientvalidatetargzarchive(tarballPath: string, expectedTopLevel: string): void {
	const paths = HcpClientlisttargz(tarballPath, false);
	const verboseEntries = HcpClientlisttargz(tarballPath, true);
	if (paths.length === 0) throw new Error("Package archive is empty");
	if (paths.length !== verboseEntries.length) {
		throw new Error("Package archive listing is ambiguous");
	}
	const normalizedPaths = new Set<string>();
	const portablePaths = new Map<string, string>();

	for (let index = 0; index < paths.length; index++) {
		const entryPath = paths[index]!;
		const type = verboseEntries[index]![0];
		if (type !== "-" && type !== "d") {
			throw new Error(
				`Package archive entry ${JSON.stringify(entryPath)} has unsupported type ${JSON.stringify(type)}`,
			);
		}
		const normalizedPath = HcpClientvalidatearchiveentrypath(entryPath, expectedTopLevel);
		if (normalizedPaths.has(normalizedPath)) {
			throw new Error(`Package archive contains a duplicate path: ${JSON.stringify(normalizedPath)}`);
		}
		normalizedPaths.add(normalizedPath);

		const portablePath = normalizedPath.normalize("NFC").toLowerCase();
		const collidingPath = portablePaths.get(portablePath);
		if (collidingPath !== undefined) {
			throw new Error(
				`Package archive paths collide on a case-insensitive Unicode-normalizing filesystem: ${JSON.stringify(collidingPath)} and ${JSON.stringify(normalizedPath)}`,
			);
		}
		portablePaths.set(portablePath, normalizedPath);
	}
}

function HcpClientlisttargz(tarballPath: string, verbose: boolean): string[] {
	const tarCommand = platform() === "win32" ? HcpClientgetwindowstarcommand() : "tar";
	const result = spawnSync(tarCommand, [verbose ? "tvzf" : "tzf", tarballPath], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 60_000,
	});
	if (result.error) throw new Error(`Failed to inspect package archive: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(
			`Package archive listing failed (exit ${result.status}): ${result.stderr?.trim() || "(no output)"}`,
		);
	}
	const output = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
	if (output === "") return [];
	return output.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function HcpClientvalidatearchiveentrypath(entryPath: string, expectedTopLevel: string): string {
	if (/[\u0000-\u001f\u007f]/.test(entryPath)) {
		throw new Error(`Package archive entry contains control characters: ${JSON.stringify(entryPath)}`);
	}
	if (entryPath.includes("\\")) {
		throw new Error(`Package archive entry uses a backslash path: ${JSON.stringify(entryPath)}`);
	}
	if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
		throw new Error(`Package archive entry is absolute: ${JSON.stringify(entryPath)}`);
	}

	const normalized = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
	const segments = normalized.split("/");
	if (
		normalized === "" ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
		segments[0] !== expectedTopLevel
	) {
		throw new Error(
			`Package archive entry must stay beneath ${JSON.stringify(expectedTopLevel)}: ${JSON.stringify(entryPath)}`,
		);
	}
	for (const segment of segments) {
		if (segment.includes(":") || /[. ]$/.test(segment) || HcpClientwindowsreservednamepattern.test(segment)) {
			throw new Error(`Package archive entry is not cross-platform safe: ${JSON.stringify(entryPath)}`);
		}
	}
	return normalized;
}

/**
 * Extract a .tar.gz archive using the system `tar` command.
 * Extracted contents are placed directly under extractDir.
 */
function HcpClientextracttargz(tarballPath: string, extractDir: string): void {
	const tarCommand = platform() === "win32" ? HcpClientgetwindowstarcommand() : "tar";
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
function HcpClientgetwindowstarcommand(): string {
	const systemRoot = process.env.SystemRoot || "C:\\Windows";
	const systemTar = join(systemRoot, "System32", "tar.exe");
	if (existsSync(systemTar)) return systemTar;
	return "tar.exe";
}
