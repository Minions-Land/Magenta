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
import type { BigIntStats, Dir, Dirent, Stats } from "node:fs";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import {
	lstat,
	open,
	opendir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import lockfile from "proper-lockfile";
import { compare as compareSemver, valid as validSemver } from "semver";
import { parse as parseToml } from "smol-toml";
import { getConfigRootDir } from "../config.ts";
import { resolveGitHubUrl } from "./github-mirror.ts";

const HcpClientpackagedownloadwalltimeoutms = 15 * 60_000;
const HcpClientpackagedownloadinactivitytimeoutms = 120_000;
const HcpClientpackagedownloadretrydelayms = 2_000;
const HcpClientpackagedownloadmaxattempts = 3;
const HcpClientpackagearchiveextractiontimeoutms = 300_000;
const HcpClientpackageartifactmaxbytes = 512 * 1024 * 1024;
const HcpClientpackagechecksummaxbytes = 1024 * 1024;
const HcpClientpackagearchiveentrymaxcount = 10_000;
const HcpClientpackageexpandedfilemaxbytes = 2 * 1024 * 1024 * 1024;
const HcpClientpackageuncompressedtarmaxbytes = HcpClientpackageexpandedfilemaxbytes + 128 * 1024 * 1024;
const HcpClientpackagearchiveinspectiontimeoutms = 120_000;
const HcpClientpackagecatalogtimeoutms = 5_000;
const HcpClientofficialpackageowner = "Minions-Land";
const HcpClientofficialpackagerepo = "Magenta-CLI";
const HcpClientpackagecacheprovenancefile = ".magenta-package-provenance.json";
const HcpClientpackagecacheprovenanceschemaversion = 3;
const HcpClientpackagecacheprovenancemaxbytes = 64 * 1024;
const HcpClientpackagemanifestmaxbytes = 1024 * 1024;
const HcpClientpackagestagingmarkerfile = ".magenta-package-staging.json";
const HcpClientpackagestagingmarkerschemaversion = 1;
const HcpClientpackagestagingmarkermaxbytes = 16 * 1024;
const HcpClientpackagegenerationmaxscan = 64;
const HcpClientpackagegenerationmaxdirectoryentries = 10_000;
const HcpClientpackagecachetreeentrymaxcount = HcpClientpackagearchiveentrymaxcount * 2;
const HcpClientgithubownerpattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const HcpClientgithubrepopattern = /^[A-Za-z0-9._-]{1,100}$/;
const HcpClientpackagenamepattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HcpClientwindowsreservednamepattern = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const HcpClientstrictsemverpattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HcpClientinflightpackageacquisitions = new Map<string, Promise<HcpClientpackageacquisitionresult>>();

function HcpClientistruthyenvflag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

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

export type HcpClientpackagecatalogentry = {
	package: string;
	version: string;
	selector: string;
	owner: string;
	repo: string;
	releaseName?: string;
	publishedAt?: string;
};

export type HcpClientpackagecatalogresult = {
	packages: HcpClientpackagecatalogentry[];
	diagnostics: HcpClientpackageacquisitiondiagnostic[];
};

type HcpClientgithubrelease = {
	tag_name?: unknown;
	name?: unknown;
	published_at?: unknown;
	draft?: unknown;
	prerelease?: unknown;
	assets?: unknown;
};

type HcpClientgithubreleaseasset = {
	name?: unknown;
};

type HcpClientpackagecatalogoptions = {
	owner?: string;
	repo?: string;
	platform?: HcpClientpackageplatformid;
	fetch?: typeof globalThis.fetch;
};

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

/**
 * Discover loadable releases from the official Harness Package repository.
 * Only stable, non-draft releases that contain both the current platform
 * archive and its adjacent SHA-256 file are returned. The newest semantic
 * version wins when a package has multiple releases.
 */
export async function HcpClientdiscoverofficialpackages(
	options: HcpClientpackagecatalogoptions = {},
): Promise<HcpClientpackagecatalogresult> {
	if (HcpClientistruthyenvflag(process.env.PI_OFFLINE)) {
		return {
			packages: [],
			diagnostics: [
				{
					type: "info",
					code: "package_catalog_offline",
					message: "Official Package discovery is disabled in offline mode",
				},
			],
		};
	}

	const owner = options.owner ?? HcpClientofficialpackageowner;
	const repo = options.repo ?? HcpClientofficialpackagerepo;
	let packagePlatform: HcpClientpackageplatformid;
	try {
		packagePlatform = options.platform ?? HcpClientgetpackageplatformid();
	} catch (error) {
		return {
			packages: [],
			diagnostics: [
				{
					type: "warning",
					code: "package_catalog_platform_unsupported",
					message: `Official Package discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
	const fetchPackageCatalog = options.fetch ?? globalThis.fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HcpClientpackagecatalogtimeoutms);
	try {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "Magenta-Package-Catalog",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		const token = process.env.MAGENTA_GITHUB_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;
		const response = await fetchPackageCatalog(
			resolveGitHubUrl(
				`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`,
			),
			{ headers, signal: controller.signal },
		);
		if (!response.ok) {
			return {
				packages: [],
				diagnostics: [
					{
						type: "warning",
						code: "package_catalog_http_error",
						message: `Official Package discovery failed: GitHub returned ${response.status} ${response.statusText}`,
					},
				],
			};
		}

		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) {
			throw new Error("GitHub releases response is not an array");
		}

		const diagnostics: HcpClientpackageacquisitiondiagnostic[] = [];
		const newestByPackage = new Map<string, HcpClientpackagecatalogentry>();
		for (const candidate of payload as HcpClientgithubrelease[]) {
			if (!candidate || typeof candidate !== "object" || candidate.draft === true || candidate.prerelease === true) {
				continue;
			}
			if (typeof candidate.tag_name !== "string") continue;
			const tagMatch = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})-v(.+)$/.exec(candidate.tag_name);
			if (!tagMatch) continue;
			const [, packageId, version] = tagMatch;
			if (!packageId || !version) continue;
			const selector = `github:${owner}/${repo}/${packageId}@${version}`;
			if (!HcpClientparsegithubpackageselector(selector)) continue;

			const assets = Array.isArray(candidate.assets)
				? (candidate.assets as HcpClientgithubreleaseasset[])
						.map((asset) => asset?.name)
						.filter((name): name is string => typeof name === "string")
				: [];
			const artifact = `${packageId}-v${version}-${packagePlatform}.tar.gz`;
			if (!assets.includes(artifact) || !assets.includes(`${artifact}.sha256`)) {
				diagnostics.push({
					type: "warning",
					code: "package_catalog_assets_missing",
					message: `Ignoring ${candidate.tag_name}: release is missing ${artifact} or its SHA-256 file`,
				});
				continue;
			}

			const entry: HcpClientpackagecatalogentry = {
				package: packageId,
				version,
				selector,
				owner,
				repo,
				...(typeof candidate.name === "string" && candidate.name ? { releaseName: candidate.name } : {}),
				...(typeof candidate.published_at === "string" && candidate.published_at
					? { publishedAt: candidate.published_at }
					: {}),
			};
			const current = newestByPackage.get(packageId);
			if (!current || compareSemver(entry.version, current.version) > 0) {
				newestByPackage.set(packageId, entry);
			}
		}

		return {
			packages: [...newestByPackage.values()].sort((left, right) => left.package.localeCompare(right.package)),
			diagnostics,
		};
	} catch (error) {
		return {
			packages: [],
			diagnostics: [
				{
					type: "warning",
					code: "package_catalog_failed",
					message: `Official Package discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	} finally {
		clearTimeout(timeout);
	}
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
	packageTreeSha256: string;
};

type HcpClientpackagestagingmarker = {
	schemaVersion: number;
	source: "github";
	owner: string;
	repo: string;
	package: string;
	version: string;
	platform: HcpClientpackageplatformid;
	stagingDirectory: string;
};

type HcpClientpackagecachepathset = {
	cacheRoot: string;
	cacheDir: string;
	packageRoot: string;
	provenancePath: string;
	lockPath: string;
	platform: HcpClientpackageplatformid;
	generationArtifactSha256?: string;
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
 * Default: <configured Magenta root>/harness-packages/
 */
export function HcpClientgetpackagecacheroot(): string {
	return join(getConfigRootDir(), "harness-packages");
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
	await HcpClientmaintainpackagecacheresidue(paths, selector, diagnostics);

	let directCacheInvalid = false;
	// Prefer the legacy/direct path when valid. An invalid direct cache may still
	// be in use by another process, so it is never removed or renamed here.
	if (await HcpClientpathentryexists(cacheDir)) {
		const invalidReason = await HcpClientvalidatecachedpackage(paths, selector);
		if (!invalidReason) {
			diagnostics.push({ type: "info", message: `Using cached ${cacheKey}` });
			return { packageRoot, cached: true, diagnostics };
		}
		directCacheInvalid = true;
		diagnostics.push({
			type: "warning",
			code: "package_cache_invalid_preserved",
			message: `Invalid direct cache for ${cacheKey} (${invalidReason}); preserving it and checking repair generations`,
		});
	}

	const cachedGeneration = await HcpClientfindvalidpackagegeneration(paths, selector, diagnostics);
	if (cachedGeneration) {
		diagnostics.push({ type: "info", message: `Using cached repair generation for ${cacheKey}` });
		return { packageRoot: cachedGeneration.packageRoot, cached: true, diagnostics };
	}

	const stagingDir = HcpClientpackagestagingdir(paths);
	const stagingPackageRoot = join(stagingDir, selector.package);
	const stagingProvenancePath = join(stagingDir, HcpClientpackagecacheprovenancefile);

	// Download and extract in a unique sibling staging directory. The final cache
	// path does not exist until the fully validated tree is atomically renamed.
	try {
		mkdirSync(dirname(cacheDir), { recursive: true });
		mkdirSync(stagingDir);
		await writeFile(
			join(stagingDir, HcpClientpackagestagingmarkerfile),
			`${JSON.stringify(HcpClientcreatepackagestagingmarker(stagingDir, paths, selector), null, 2)}\n`,
			{ encoding: "utf-8", flag: "wx", mode: 0o600 },
		);
		const tag = `${selector.package}-v${selector.version}`;
		const artifact = `${tag}-${packagePlatform}.tar.gz`;
		const artifactUrl = resolveGitHubUrl(
			`https://github.com/${encodeURIComponent(selector.owner)}/${encodeURIComponent(selector.repo)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact)}`,
		);
		const checksumUrl = `${artifactUrl}.sha256`;

		const tempDir = join(stagingDir, ".download");
		mkdirSync(tempDir, { recursive: true });
		const tarballPath = join(tempDir, artifact);
		const checksumPath = join(tempDir, `${artifact}.sha256`);
		const downloadDeadline = Date.now() + HcpClientpackagedownloadwalltimeoutms;

		// Download tarball
		diagnostics.push({ type: "info", message: `Downloading ${selector.package} v${selector.version}...` });
		await HcpClientdownloadpackagefile(
			artifactUrl,
			tarballPath,
			HcpClientpackageartifactmaxbytes,
			downloadDeadline,
			artifact,
		);

		// Download checksum
		await HcpClientdownloadpackagefile(
			checksumUrl,
			checksumPath,
			HcpClientpackagechecksummaxbytes,
			downloadDeadline,
			`${artifact}.sha256`,
		);

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
		await HcpClientvalidatetargzarchive(tarballPath, selector.package);
		HcpClientextracttargz(tarballPath, stagingDir);

		// Clean up temp files
		rmSync(tempDir, { recursive: true, force: true });

		// Validate the extracted manifest before marking the cache usable. The
		// provenance file is written last, so an interrupted install is never
		// accepted as a verified cache entry on the next launch.
		await HcpClientvalidatepackagemanifest(stagingPackageRoot, selector);
		const packageTreeSha256 = await HcpClientcomputepackagetreesha256(stagingPackageRoot);
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
			packageTreeSha256,
		};
		await writeFile(stagingProvenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf-8");

		const publishPaths = directCacheInvalid
			? await HcpClientselectpackagegenerationpaths(paths, selector, actualHash)
			: paths;
		const published = await HcpClientpublishstagedcache(stagingDir, publishPaths, selector);
		if (!published) {
			diagnostics.push({ type: "info", message: `Another process installed ${cacheKey}` });
			return { packageRoot: publishPaths.packageRoot, cached: true, diagnostics };
		}

		diagnostics.push({
			type: "info",
			message: `${directCacheInvalid ? "Installed repair generation for" : "Installed"} ${cacheKey}`,
		});
		return { packageRoot: publishPaths.packageRoot, cached: false, diagnostics };
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
	const lockTarget = dirname(paths.lockPath);
	mkdirSync(lockTarget, { recursive: true });
	return lockfile.lock(lockTarget, {
		lockfilePath: `${paths.lockPath}.lock`,
		realpath: false,
		retries: {
			retries: 120,
			factor: 1.2,
			minTimeout: 100,
			maxTimeout: 5000,
			randomize: true,
		},
		stale: HcpClientpackagedownloadwalltimeoutms,
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

function HcpClientresolvepackagegenerationpaths(
	paths: HcpClientpackagecachepathset,
	generationName: string,
	artifactSha256: string,
): HcpClientpackagecachepathset {
	const cacheDir = resolve(dirname(paths.cacheDir), generationName);
	HcpClientassertpathwithin(paths.cacheRoot, cacheDir, "package cache generation directory");
	const packageRoot = resolve(cacheDir, basename(paths.packageRoot));
	HcpClientassertpathwithin(cacheDir, packageRoot, "generated package root");
	return {
		cacheRoot: paths.cacheRoot,
		cacheDir,
		packageRoot,
		provenancePath: join(cacheDir, HcpClientpackagecacheprovenancefile),
		lockPath: paths.lockPath,
		platform: paths.platform,
		generationArtifactSha256: artifactSha256,
	};
}

function HcpClientparsepackagegenerationname(
	name: string,
	platformId: HcpClientpackageplatformid,
): { artifactSha256: string } | undefined {
	const prefix = `.${platformId}.generation-`;
	if (!name.startsWith(prefix)) return undefined;
	const match = /^([a-f0-9]{64})(?:-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?$/.exec(name.slice(prefix.length));
	return match?.[1] ? { artifactSha256: match[1] } : undefined;
}

async function HcpClientfindvalidpackagegeneration(
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
	diagnostics: HcpClientpackageacquisitiondiagnostic[],
): Promise<HcpClientpackagecachepathset | undefined> {
	const generationParent = dirname(paths.cacheDir);
	let directory: Dir;
	try {
		directory = await opendir(generationParent);
	} catch (error) {
		if (HcpClientisfilesystemerror(error, "ENOENT")) return undefined;
		diagnostics.push({
			type: "warning",
			code: "package_cache_generation_scan_failed",
			message: `Could not inspect package repair generations in ${generationParent}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
		return undefined;
	}

	const candidates: HcpClientpackagecachepathset[] = [];
	let directoryEntries = 0;
	for await (const entry of directory) {
		directoryEntries++;
		if (directoryEntries > HcpClientpackagegenerationmaxdirectoryentries) {
			throw new Error(
				`Package repair generation lookup exceeded the ${HcpClientpackagegenerationmaxdirectoryentries}-entry directory scan limit in ${generationParent}`,
			);
		}
		const parsed = HcpClientparsepackagegenerationname(entry.name, paths.platform);
		if (!parsed) continue;
		if (candidates.length >= HcpClientpackagegenerationmaxscan) {
			throw new Error(
				`Package cache contains more than ${HcpClientpackagegenerationmaxscan} repair generations in ${generationParent}; refusing to create another generation`,
			);
		}
		candidates.push(HcpClientresolvepackagegenerationpaths(paths, entry.name, parsed.artifactSha256));
	}

	candidates.sort((left, right) => left.cacheDir.localeCompare(right.cacheDir));
	for (const candidate of candidates) {
		const invalidReason = await HcpClientvalidatecachedpackage(candidate, selector);
		if (!invalidReason) return candidate;
		diagnostics.push({
			type: "warning",
			code: "package_cache_generation_invalid_preserved",
			message: `Preserved invalid package repair generation ${candidate.cacheDir}: ${invalidReason}`,
		});
	}
	return undefined;
}

async function HcpClientselectpackagegenerationpaths(
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
	artifactSha256: string,
): Promise<HcpClientpackagecachepathset> {
	const prefix = `.${paths.platform}.generation-${artifactSha256}`;
	const primary = HcpClientresolvepackagegenerationpaths(paths, prefix, artifactSha256);
	if (!(await HcpClientpathentryexists(primary.cacheDir))) return primary;
	if (!(await HcpClientvalidatecachedpackage(primary, selector))) return primary;

	for (let attempt = 0; attempt < 16; attempt++) {
		const candidate = HcpClientresolvepackagegenerationpaths(paths, `${prefix}-${randomUUID()}`, artifactSha256);
		if (!(await HcpClientpathentryexists(candidate.cacheDir))) return candidate;
	}
	throw new Error(`Could not allocate an immutable repair generation for ${basename(paths.cacheDir)}`);
}

function HcpClientpackagestagingdir(paths: HcpClientpackagecachepathset): string {
	const stagingDir = resolve(
		dirname(paths.cacheDir),
		`.${basename(paths.cacheDir)}.staging-${process.pid}-${randomUUID()}`,
	);
	HcpClientassertpathwithin(paths.cacheRoot, stagingDir, "package staging directory");
	return stagingDir;
}

function HcpClientcreatepackagestagingmarker(
	stagingDir: string,
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
): HcpClientpackagestagingmarker {
	return {
		schemaVersion: HcpClientpackagestagingmarkerschemaversion,
		source: "github",
		owner: selector.owner.toLowerCase(),
		repo: selector.repo.toLowerCase(),
		package: selector.package,
		version: selector.version,
		platform: paths.platform,
		stagingDirectory: basename(stagingDir),
	};
}

type HcpClientpackageresiduecleanupresult = {
	removed: boolean;
	reason?: string;
};

async function HcpClientmaintainpackagecacheresidue(
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
	diagnostics: HcpClientpackageacquisitiondiagnostic[],
): Promise<void> {
	try {
		const sentinelResult = await HcpClientretirelegacypackagelocksentinel(paths);
		if (sentinelResult.removed) {
			diagnostics.push({
				type: "info",
				code: "package_cache_residue_removed",
				message: `Removed legacy package lock sentinel ${paths.lockPath}`,
			});
		} else if (sentinelResult.reason) {
			diagnostics.push({
				type: "warning",
				code: "package_cache_residue_preserved",
				message: `Preserved legacy package lock sentinel ${paths.lockPath}: ${sentinelResult.reason}`,
			});
		}
	} catch (error) {
		diagnostics.push({
			type: "warning",
			code: "package_cache_residue_cleanup_failed",
			message: `Could not retire legacy package lock sentinel ${paths.lockPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}

	const stagingParent = dirname(paths.cacheDir);
	const stagingPrefix = `.${basename(paths.cacheDir)}.staging-`;
	let entries: Dirent[];
	try {
		entries = await readdir(stagingParent, { withFileTypes: true });
	} catch (error) {
		if (HcpClientisfilesystemerror(error, "ENOENT")) return;
		diagnostics.push({
			type: "warning",
			code: "package_cache_residue_cleanup_failed",
			message: `Could not inspect package staging residue in ${stagingParent}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
		return;
	}

	for (const entry of entries) {
		if (!entry.name.startsWith(stagingPrefix)) continue;
		const stagingDir = resolve(stagingParent, entry.name);
		HcpClientassertpathwithin(paths.cacheRoot, stagingDir, "package staging directory");
		try {
			const result = await HcpClientcleanupstagingresidue(stagingDir, paths, selector);
			if (result.removed) {
				diagnostics.push({
					type: "info",
					code: "package_cache_residue_removed",
					message: `Removed abandoned package staging directory ${stagingDir}`,
				});
			} else if (result.reason) {
				diagnostics.push({
					type: "warning",
					code: "package_cache_residue_preserved",
					message: `Preserved unverified package staging residue ${stagingDir}: ${result.reason}`,
				});
			}
		} catch (error) {
			if (HcpClientisfilesystemerror(error, "ENOENT")) continue;
			diagnostics.push({
				type: "warning",
				code: "package_cache_residue_cleanup_failed",
				message: `Could not clean package staging residue ${stagingDir}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}
	}
}

async function HcpClientcleanupstagingresidue(
	stagingDir: string,
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
): Promise<HcpClientpackageresiduecleanupresult> {
	const initialInfo = await lstat(stagingDir);
	if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink()) {
		return { removed: false, reason: "entry is not a real directory" };
	}
	if (!HcpClientisownedbycurrentuser(initialInfo)) {
		return { removed: false, reason: "directory is owned by another user" };
	}

	const initialEntries = await readdir(stagingDir);
	const isLegacyEmptyDirectory = initialEntries.length === 0;
	const hasOwnedMarker = await HcpClienthasownedpackagestagingmarker(
		stagingDir,
		basename(stagingDir),
		paths,
		selector,
	);
	if (!isLegacyEmptyDirectory && !hasOwnedMarker) {
		return { removed: false, reason: "non-empty directory has no matching ownership marker" };
	}

	const quarantineDir = HcpClientpackagequarantinepath(paths.cacheRoot, stagingDir);
	await rename(stagingDir, quarantineDir);
	const quarantinedInfo = await lstat(quarantineDir);
	if (!HcpClientissamefilesystementry(initialInfo, quarantinedInfo)) {
		return { removed: false, reason: `filesystem identity changed; entry was retained at ${quarantineDir}` };
	}

	if (hasOwnedMarker) {
		const markerStillMatches = await HcpClienthasownedpackagestagingmarker(
			quarantineDir,
			basename(stagingDir),
			paths,
			selector,
		);
		if (!markerStillMatches) {
			return { removed: false, reason: `ownership changed; entry was retained at ${quarantineDir}` };
		}
		await rm(quarantineDir, { recursive: true, force: false });
		return { removed: true };
	}

	if ((await readdir(quarantineDir)).length !== 0) {
		return { removed: false, reason: `directory became non-empty; entry was retained at ${quarantineDir}` };
	}
	await rmdir(quarantineDir);
	return { removed: true };
}

async function HcpClienthasownedpackagestagingmarker(
	stagingDir: string,
	expectedStagingDirectory: string,
	paths: HcpClientpackagecachepathset,
	selector: HcpClientgithubpackageselector,
): Promise<boolean> {
	try {
		const directoryInfo = await lstat(stagingDir);
		if (
			!directoryInfo.isDirectory() ||
			directoryInfo.isSymbolicLink() ||
			!HcpClientisownedbycurrentuser(directoryInfo)
		) {
			return false;
		}
		const markerPath = join(stagingDir, HcpClientpackagestagingmarkerfile);
		const markerRaw = await HcpClientreadboundedregularfile(
			markerPath,
			HcpClientpackagestagingmarkermaxbytes,
			"package staging marker",
		);
		const marker = JSON.parse(markerRaw) as Partial<HcpClientpackagestagingmarker>;
		return (
			marker.schemaVersion === HcpClientpackagestagingmarkerschemaversion &&
			marker.source === "github" &&
			marker.owner === selector.owner.toLowerCase() &&
			marker.repo === selector.repo.toLowerCase() &&
			marker.package === selector.package &&
			marker.version === selector.version &&
			marker.platform === paths.platform &&
			marker.stagingDirectory === expectedStagingDirectory
		);
	} catch {
		return false;
	}
}

async function HcpClientretirelegacypackagelocksentinel(
	paths: HcpClientpackagecachepathset,
): Promise<HcpClientpackageresiduecleanupresult> {
	let initialInfo: Stats;
	try {
		initialInfo = await lstat(paths.lockPath);
	} catch (error) {
		if (HcpClientisfilesystemerror(error, "ENOENT")) return { removed: false };
		throw error;
	}
	if (!HcpClientissafelegacypackagelocksentinel(initialInfo)) {
		return { removed: false, reason: "entry is not an owner-owned, zero-byte, single-link regular file" };
	}

	const quarantinePath = HcpClientpackagequarantinepath(paths.cacheRoot, paths.lockPath);
	await rename(paths.lockPath, quarantinePath);
	const quarantinedInfo = await lstat(quarantinePath);
	if (
		!HcpClientissamefilesystementry(initialInfo, quarantinedInfo) ||
		!HcpClientissafelegacypackagelocksentinel(quarantinedInfo)
	) {
		return { removed: false, reason: `filesystem identity changed; entry was retained at ${quarantinePath}` };
	}
	await unlink(quarantinePath);
	return { removed: true };
}

function HcpClientissafelegacypackagelocksentinel(info: Stats): boolean {
	return (
		info.isFile() &&
		!info.isSymbolicLink() &&
		info.size === 0 &&
		info.nlink === 1 &&
		HcpClientisownedbycurrentuser(info)
	);
}

function HcpClientisownedbycurrentuser(info: { uid: number | bigint }): boolean {
	if (typeof process.getuid !== "function") return true;
	return typeof info.uid === "bigint" ? info.uid === BigInt(process.getuid()) : info.uid === process.getuid();
}

function HcpClientissamefilesystementry(
	left: { dev: number; ino: number },
	right: { dev: number; ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function HcpClientreadboundedregularfile(
	filePath: string,
	maxBytes: number,
	description: string,
): Promise<string> {
	const pathInfo = await lstat(filePath);
	if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
		throw new Error(`${description} is not a real file: ${filePath}`);
	}
	if (pathInfo.size > maxBytes || pathInfo.nlink !== 1 || !HcpClientisownedbycurrentuser(pathInfo)) {
		throw new Error(`${description} size or ownership is invalid: ${filePath}`);
	}

	const handle = await open(filePath, "r");
	try {
		const openedInfo = await handle.stat();
		if (
			!HcpClientissamefilesystementry(pathInfo, openedInfo) ||
			!openedInfo.isFile() ||
			openedInfo.size > maxBytes ||
			openedInfo.nlink !== 1 ||
			!HcpClientisownedbycurrentuser(openedInfo) ||
			openedInfo.mode !== pathInfo.mode ||
			openedInfo.mtimeMs !== pathInfo.mtimeMs ||
			openedInfo.ctimeMs !== pathInfo.ctimeMs
		) {
			throw new Error(`${description} changed while opening: ${filePath}`);
		}

		const buffer = Buffer.alloc(Math.min(maxBytes + 1, openedInfo.size + 1));
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const readResult = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (readResult.bytesRead === 0) break;
			bytesRead += readResult.bytesRead;
		}
		const [finalInfo, finalPathInfo] = await Promise.all([handle.stat(), lstat(filePath)]);
		if (
			bytesRead > maxBytes ||
			finalInfo.size !== openedInfo.size ||
			finalInfo.size !== bytesRead ||
			!HcpClientissamefilesystementry(openedInfo, finalInfo) ||
			!HcpClientissamefilesystementry(finalInfo, finalPathInfo) ||
			finalInfo.nlink !== 1 ||
			finalPathInfo.nlink !== 1 ||
			!HcpClientisownedbycurrentuser(finalInfo) ||
			!HcpClientisownedbycurrentuser(finalPathInfo) ||
			finalInfo.mode !== openedInfo.mode ||
			finalInfo.mtimeMs !== openedInfo.mtimeMs ||
			finalInfo.ctimeMs !== openedInfo.ctimeMs ||
			finalPathInfo.mode !== finalInfo.mode ||
			finalPathInfo.mtimeMs !== finalInfo.mtimeMs ||
			finalPathInfo.ctimeMs !== finalInfo.ctimeMs
		) {
			throw new Error(`${description} changed or exceeded its ${maxBytes}-byte limit: ${filePath}`);
		}
		return buffer.subarray(0, bytesRead).toString("utf-8");
	} finally {
		await handle.close();
	}
}

function HcpClientpackagequarantinepath(cacheRoot: string, target: string): string {
	const quarantinePath = resolve(
		dirname(target),
		`.magenta-package-quarantine-${basename(target)}-${process.pid}-${randomUUID()}`,
	);
	HcpClientassertpathwithin(cacheRoot, quarantinePath, "package cache quarantine path");
	return quarantinePath;
}

function HcpClientisfilesystemerror(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function HcpClientpathentryexists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (HcpClientisfilesystemerror(error, "ENOENT")) return false;
		throw error;
	}
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
	if (await HcpClientpathentryexists(paths.cacheDir)) {
		const invalidReason = await HcpClientvalidatecachedpackage(paths, selector);
		if (invalidReason) {
			throw new Error(`cache destination already exists but is invalid: ${invalidReason}`);
		}
		HcpClientremovecachedir(paths.cacheRoot, stagingDir);
		return false;
	}
	try {
		await rename(stagingDir, paths.cacheDir);
		await rm(join(paths.cacheDir, HcpClientpackagestagingmarkerfile), { force: true }).catch(() => undefined);
		return true;
	} catch (error) {
		if (!(await HcpClientpathentryexists(paths.cacheDir))) throw error;
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
		if (!HcpClientisownedbycurrentuser(cacheInfo)) {
			return `cache entry is owned by another user: ${paths.cacheDir}`;
		}
		const provenanceInfo = await lstat(paths.provenancePath);
		if (!provenanceInfo.isFile() || provenanceInfo.isSymbolicLink()) {
			return `cache provenance is not a real file: ${paths.provenancePath}`;
		}
		if (provenanceInfo.nlink !== 1 || !HcpClientisownedbycurrentuser(provenanceInfo)) {
			return `cache provenance ownership is invalid: ${paths.provenancePath}`;
		}
		const [actualCacheRoot, actualCacheDir, actualPackageRoot] = await Promise.all([
			realpath(paths.cacheRoot),
			realpath(paths.cacheDir),
			realpath(paths.packageRoot),
		]);
		HcpClientassertpathwithin(actualCacheRoot, actualCacheDir, "package cache directory");
		HcpClientassertpathwithin(actualCacheDir, actualPackageRoot, "cached package root");
		const provenanceRaw = await HcpClientreadboundedregularfile(
			paths.provenancePath,
			HcpClientpackagecacheprovenancemaxbytes,
			"package cache provenance",
		);
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
			!/^[a-f0-9]{64}$/.test(provenance.artifactSha256) ||
			typeof provenance.packageTreeSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(provenance.packageTreeSha256) ||
			(paths.generationArtifactSha256 !== undefined && provenance.artifactSha256 !== paths.generationArtifactSha256)
		) {
			return "provenance does not match the requested origin";
		}
		await HcpClientvalidatepackagemanifest(paths.packageRoot, selector);
		const actualPackageTreeSha256 = await HcpClientcomputepackagetreesha256(paths.packageRoot);
		if (actualPackageTreeSha256 !== provenance.packageTreeSha256) {
			return `cached package content digest mismatch: expected ${provenance.packageTreeSha256}, got ${actualPackageTreeSha256}`;
		}
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
	if (!HcpClientisownedbycurrentuser(packageInfo)) {
		throw new Error(`extracted package root is owned by another user: ${packageRoot}`);
	}
	const manifestPath = join(packageRoot, "package.toml");
	const manifestInfo = await lstat(manifestPath);
	if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
		throw new Error(`package.toml is not a real file: ${manifestPath}`);
	}
	if (manifestInfo.nlink !== 1 || !HcpClientisownedbycurrentuser(manifestInfo)) {
		throw new Error(`package.toml ownership is invalid: ${manifestPath}`);
	}
	const manifestRaw = await HcpClientreadboundedregularfile(
		manifestPath,
		HcpClientpackagemanifestmaxbytes,
		"package manifest",
	);
	const manifest = parseToml(manifestRaw) as Record<string, unknown>;
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
 * Download one package asset within the acquisition-wide wall deadline.
 */
export type HcpClientpackagedownloadoptions = {
	inactivityTimeoutMs?: number;
	retryDelayMs?: number;
	maxAttempts?: number;
};

/** @internal Exported for deterministic transport-boundary tests. */
export async function HcpClientdownloadpackagefile(
	url: string,
	dest: string,
	maxBytes: number,
	deadline: number,
	assetName: string,
	options: HcpClientpackagedownloadoptions = {},
): Promise<void> {
	const inactivityTimeoutMs = options.inactivityTimeoutMs ?? HcpClientpackagedownloadinactivitytimeoutms;
	const retryDelayMs = options.retryDelayMs ?? HcpClientpackagedownloadretrydelayms;
	const maxAttempts = options.maxAttempts ?? HcpClientpackagedownloadmaxattempts;
	if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
		throw new RangeError("Package download inactivity timeout must be a positive finite number");
	}
	if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
		throw new RangeError("Package download retry delay must be a finite non-negative number");
	}
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
		throw new RangeError("Package download max attempts must be a positive safe integer");
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (Date.now() >= deadline) {
			throw HcpClientpackagedownloadwalltimeouterror(assetName, deadline, attempt - 1);
		}

		const controller = new AbortController();
		let wallTimer: NodeJS.Timeout | undefined;
		let inactivityTimer: NodeJS.Timeout | undefined;
		let destinationCreated = false;
		let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
		let responseBody: ReadableStream<Uint8Array> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let completed = false;

		const clearTimers = () => {
			if (wallTimer) clearTimeout(wallTimer);
			if (inactivityTimer) clearTimeout(inactivityTimer);
			wallTimer = undefined;
			inactivityTimer = undefined;
		};
		const abortAttempt = (error: HcpClientpackagedownloaderror) => {
			if (!controller.signal.aborted) controller.abort(error);
		};
		const resetInactivityTimer = () => {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(() => {
				abortAttempt(
					new HcpClientpackagedownloaderror(
						`Download of ${assetName} stalled: no data was received for ${inactivityTimeoutMs}ms (attempt ${attempt}/${maxAttempts})`,
						true,
					),
				);
			}, inactivityTimeoutMs);
		};

		try {
			wallTimer = setTimeout(
				() => abortAttempt(HcpClientpackagedownloadwalltimeouterror(assetName, deadline, attempt)),
				Math.max(1, deadline - Date.now()),
			);
			resetInactivityTimer();
			const response = await HcpClientwaitwithabort(
				fetch(url, {
					headers: { "User-Agent": "Magenta-Package-Acquisition" },
					signal: controller.signal,
				}),
				controller.signal,
			);
			responseBody = response.body ?? undefined;
			if (!response.ok) {
				throw new HcpClientpackagedownloaderror(
					`HTTP ${response.status}: ${response.statusText}`,
					response.status === 408 || response.status === 429 || response.status >= 500,
				);
			}
			if (!responseBody) throw new HcpClientpackagedownloaderror("Response body is empty", true);

			const contentLength = response.headers.get("content-length")?.trim();
			if (contentLength !== undefined) {
				if (!/^\d+$/.test(contentLength)) {
					throw new HcpClientpackagedownloaderror(
						`Download returned an invalid Content-Length: ${contentLength}`,
						false,
					);
				}
				if (BigInt(contentLength) > BigInt(maxBytes)) {
					throw new HcpClientpackagedownloaderror(
						`Download declares ${contentLength} bytes, exceeding the ${maxBytes}-byte limit`,
						false,
					);
				}
			}

			controller.signal.throwIfAborted();
			destinationHandle = await open(dest, "wx", 0o600);
			destinationCreated = true;
			reader = responseBody.getReader();
			let receivedBytes = 0;
			while (true) {
				const chunk = await HcpClientwaitwithabort(reader.read(), controller.signal);
				if (chunk.done) break;
				if (chunk.value.byteLength > 0) resetInactivityTimer();
				receivedBytes += chunk.value.byteLength;
				if (receivedBytes > maxBytes) {
					throw new HcpClientpackagedownloaderror(
						`Download exceeded the ${maxBytes}-byte limit while streaming`,
						false,
					);
				}
				await destinationHandle.writeFile(chunk.value);
				controller.signal.throwIfAborted();
			}
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = undefined;
			await destinationHandle.sync();
			controller.signal.throwIfAborted();
			await destinationHandle.close();
			destinationHandle = undefined;
			completed = true;
			return;
		} catch (rawError) {
			const error = controller.signal.aborted
				? HcpClientpackageabortreason(controller.signal)
				: rawError instanceof Error
					? rawError
					: new Error(String(rawError));
			clearTimers();
			if (reader) {
				void reader.cancel().catch(() => undefined);
				reader = undefined;
			} else if (responseBody) void responseBody.cancel().catch(() => undefined);
			if (destinationHandle) await destinationHandle.close().catch(() => undefined);
			if (destinationCreated) {
				try {
					await rm(dest, { force: false });
				} catch (cleanupError) {
					if (!HcpClientisfilesystemerror(cleanupError, "ENOENT")) {
						throw new Error(`Failed to remove partial package download ${dest} after: ${error.message}`, {
							cause: cleanupError,
						});
					}
				}
			}

			if (Date.now() >= deadline) {
				throw HcpClientpackagedownloadwalltimeouterror(assetName, deadline, attempt);
			}
			if (!HcpClientisretryablepackagedownloaderror(error) || attempt === maxAttempts) {
				throw error;
			}
			await HcpClientwaitforpackagedownloadretry(retryDelayMs * attempt, deadline, assetName, attempt);
		} finally {
			clearTimers();
			if (!completed && reader) void reader.cancel().catch(() => undefined);
		}
	}
}

class HcpClientpackagedownloaderror extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean, options?: ErrorOptions) {
		super(message, options);
		this.name = "HcpClientpackagedownloaderror";
		this.retryable = retryable;
	}
}

function HcpClientpackageabortreason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted");
}

function HcpClientwaitwithabort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(HcpClientpackageabortreason(signal));
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			rejectPromise(HcpClientpackageabortreason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				rejectPromise(error);
			},
		);
	});
}

function HcpClientisretryablepackagedownloaderror(error: Error): boolean {
	if (error instanceof HcpClientpackagedownloaderror) return error.retryable;
	const message = error.message.toLowerCase();
	return (
		error.name === "AbortError" ||
		message.includes("aborted") ||
		message.includes("timeout") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("etimedout") ||
		message.includes("enotfound") ||
		message.includes("eai_again") ||
		message.includes("socket connection was closed") ||
		message.includes("unable to connect") ||
		message.includes("fetch failed")
	);
}

function HcpClientpackagedownloadwalltimeouterror(
	assetName: string,
	_deadline: number,
	attempts: number,
): HcpClientpackagedownloaderror {
	return new HcpClientpackagedownloaderror(
		`Download of ${assetName} exceeded the shared package download deadline after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
		false,
	);
}

async function HcpClientwaitforpackagedownloadretry(
	delayMs: number,
	deadline: number,
	assetName: string,
	attempts: number,
): Promise<void> {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) throw HcpClientpackagedownloadwalltimeouterror(assetName, deadline, attempts);
	const boundedDelayMs = Math.min(delayMs, remainingMs);
	if (boundedDelayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, boundedDelayMs));
	if (Date.now() >= deadline) throw HcpClientpackagedownloadwalltimeouterror(assetName, deadline, attempts);
}

/**
 * Compute SHA256 hash of a file (hex string).
 */
async function HcpClientcomputepackagesha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

type HcpClientpackagetreehashstate = {
	hash: ReturnType<typeof createHash>;
	entryCount: number;
	fileBytes: bigint;
};

async function HcpClientcomputepackagetreesha256(packageRoot: string): Promise<string> {
	const state: HcpClientpackagetreehashstate = {
		hash: createHash("sha256").update("magenta-package-tree-v1\n"),
		entryCount: 0,
		fileBytes: 0n,
	};
	await HcpClienthashpackagetreeentry(packageRoot, "", state);
	return state.hash.digest("hex");
}

async function HcpClienthashpackagetreeentry(
	absolutePath: string,
	relativePath: string,
	state: HcpClientpackagetreehashstate,
): Promise<void> {
	state.entryCount++;
	if (state.entryCount > HcpClientpackagecachetreeentrymaxcount) {
		throw new Error(`Package tree contains more than ${HcpClientpackagecachetreeentrymaxcount} filesystem entries`);
	}

	const initialInfo = await lstat(absolutePath, { bigint: true });
	if (initialInfo.isSymbolicLink()) {
		throw new Error(`Package tree contains a symbolic link: ${absolutePath}`);
	}
	if (!HcpClientisownedbycurrentuser(initialInfo)) {
		throw new Error(`Package tree entry is owned by another user: ${absolutePath}`);
	}
	const digestPath = relativePath || ".";
	const permissionMode = Number(initialInfo.mode & 0o777n);

	if (initialInfo.isDirectory()) {
		state.hash.update(`${JSON.stringify({ type: "directory", path: digestPath, mode: permissionMode })}\n`, "utf-8");
		const entries = await HcpClientreadboundedpackagedirectory(
			absolutePath,
			HcpClientpackagecachetreeentrymaxcount - state.entryCount,
		);
		entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
		for (const entry of entries) {
			await HcpClienthashpackagetreeentry(
				join(absolutePath, entry),
				relativePath ? `${relativePath}/${entry}` : entry,
				state,
			);
		}
		const finalInfo = await lstat(absolutePath, { bigint: true });
		HcpClientassertstablepackagetreeentry(initialInfo, finalInfo, absolutePath);
		return;
	}

	if (!initialInfo.isFile() || initialInfo.nlink !== 1n) {
		throw new Error(`Package tree entry is not a single-link regular file: ${absolutePath}`);
	}
	state.fileBytes += initialInfo.size;
	if (state.fileBytes > BigInt(HcpClientpackageexpandedfilemaxbytes)) {
		throw new Error(`Package tree exceeds the ${HcpClientpackageexpandedfilemaxbytes}-byte file limit`);
	}

	const contentHash = createHash("sha256");
	const handle = await open(absolutePath, "r");
	let bytesRead = 0;
	try {
		const openedInfo = await handle.stat({ bigint: true });
		HcpClientassertstablepackagetreeentry(initialInfo, openedInfo, absolutePath);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		while (bytesRead < Number(openedInfo.size)) {
			const result = await handle.read(
				buffer,
				0,
				Math.min(buffer.length, Number(openedInfo.size) - bytesRead),
				bytesRead,
			);
			if (result.bytesRead === 0) break;
			contentHash.update(buffer.subarray(0, result.bytesRead));
			bytesRead += result.bytesRead;
		}
		const [finalInfo, finalPathInfo] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(absolutePath, { bigint: true }),
		]);
		HcpClientassertstablepackagetreeentry(openedInfo, finalInfo, absolutePath);
		HcpClientassertstablepackagetreeentry(finalInfo, finalPathInfo, absolutePath);
		if (BigInt(bytesRead) !== finalInfo.size) {
			throw new Error(`Package tree file changed while hashing: ${absolutePath}`);
		}
	} finally {
		await handle.close();
	}

	state.hash.update(
		`${JSON.stringify({
			type: "file",
			path: digestPath,
			mode: permissionMode,
			size: initialInfo.size.toString(),
			sha256: contentHash.digest("hex"),
		})}\n`,
		"utf-8",
	);
}

async function HcpClientreadboundedpackagedirectory(directoryPath: string, maxEntries: number): Promise<string[]> {
	const directory = await opendir(directoryPath);
	const entries: string[] = [];
	for await (const entry of directory) {
		if (entries.length >= maxEntries) {
			throw new Error(
				`Package tree contains more than ${HcpClientpackagecachetreeentrymaxcount} filesystem entries`,
			);
		}
		entries.push(entry.name);
	}
	return entries;
}

function HcpClientassertstablepackagetreeentry(before: BigIntStats, after: BigIntStats, path: string): void {
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.mode !== after.mode ||
		before.uid !== after.uid ||
		before.nlink !== after.nlink ||
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	) {
		throw new Error(`Package tree entry changed while hashing: ${path}`);
	}
}

/** Reject resource amplification, tar-slip paths, and non-file/directory entries. */
async function HcpClientvalidatetargzarchive(tarballPath: string, expectedTopLevel: string): Promise<void> {
	await HcpClientvalidateuncompressedtarsize(tarballPath);
	const paths = HcpClientlisttargz(tarballPath, false);
	if (paths.length === 0) throw new Error("Package archive is empty");
	if (paths.length > HcpClientpackagearchiveentrymaxcount) {
		throw new Error(
			`Package archive contains ${paths.length} entries, exceeding the ${HcpClientpackagearchiveentrymaxcount}-entry limit`,
		);
	}
	const verboseEntries = HcpClientlisttargz(tarballPath, true);
	if (paths.length !== verboseEntries.length) {
		throw new Error("Package archive listing is ambiguous");
	}
	const normalizedPaths = new Set<string>();
	const portablePaths = new Map<string, string>();
	let expandedFileBytes = 0;

	for (let index = 0; index < paths.length; index++) {
		const entryPath = paths[index]!;
		const verboseEntry = verboseEntries[index]!;
		const type = verboseEntry[0];
		if (type !== "-" && type !== "d") {
			throw new Error(
				`Package archive entry ${JSON.stringify(entryPath)} has unsupported type ${JSON.stringify(type)}`,
			);
		}
		const normalizedPath = HcpClientvalidatearchiveentrypath(entryPath, expectedTopLevel);
		const entrySize = HcpClientparsepackagetarverboseentrysize(verboseEntry, entryPath);
		if (type === "d" && entrySize !== 0) {
			throw new Error(`Package archive directory has a non-zero size: ${JSON.stringify(entryPath)}`);
		}
		if (type === "-") {
			expandedFileBytes += entrySize;
			if (expandedFileBytes > HcpClientpackageexpandedfilemaxbytes) {
				throw new Error(
					`Package archive expands to more than the ${HcpClientpackageexpandedfilemaxbytes}-byte file limit`,
				);
			}
		}
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

async function HcpClientvalidateuncompressedtarsize(tarballPath: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HcpClientpackagearchiveinspectiontimeoutms);
	let uncompressedBytes = 0;
	try {
		await pipeline(
			createReadStream(tarballPath),
			createGunzip(),
			async (chunks) => {
				for await (const chunk of chunks) {
					uncompressedBytes += Buffer.byteLength(chunk);
					if (uncompressedBytes > HcpClientpackageuncompressedtarmaxbytes) {
						throw new Error(
							`Package archive expands to more than the ${HcpClientpackageuncompressedtarmaxbytes}-byte tar-stream limit`,
						);
					}
				}
			},
			{ signal: controller.signal },
		);
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`Package archive inspection timed out after ${HcpClientpackagearchiveinspectiontimeoutms}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export function HcpClientparsepackagetarverboseentrysize(verboseEntry: string, entryPath: string): number {
	if (!verboseEntry.endsWith(entryPath)) {
		throw new Error(`Package archive verbose listing does not match ${JSON.stringify(entryPath)}`);
	}
	const metadataEnd = verboseEntry.length - entryPath.length;
	if (metadataEnd === 0 || !/\s/.test(verboseEntry[metadataEnd - 1]!)) {
		throw new Error(`Package archive verbose listing is ambiguous for ${JSON.stringify(entryPath)}`);
	}
	const fields = verboseEntry.slice(0, metadataEnd).trim().split(/\s+/);
	let sizeText: string | undefined;
	if (
		fields.length === 8 &&
		/^\d+$/.test(fields[1] ?? "") &&
		/^\d+$/.test(fields[2] ?? "") &&
		/^\d+$/.test(fields[3] ?? "")
	) {
		// bsdtar: mode links uid gid size month day time-or-year path
		sizeText = fields[4];
	} else if (fields.length === 5 && /^\d+\/\d+$/.test(fields[1] ?? "")) {
		// GNU tar: mode uid/gid size yyyy-mm-dd hh:mm path
		sizeText = fields[2];
	}
	if (!sizeText || !/^\d+$/.test(sizeText)) {
		throw new Error(`Package archive verbose listing has an unsupported format for ${JSON.stringify(entryPath)}`);
	}
	const size = Number(sizeText);
	if (!Number.isSafeInteger(size)) {
		throw new Error(`Package archive entry size is not a safe integer for ${JSON.stringify(entryPath)}`);
	}
	return size;
}

function HcpClientlisttargz(tarballPath: string, verbose: boolean): string[] {
	const tarCommand = platform() === "win32" ? HcpClientgetwindowstarcommand() : "tar";
	const result = spawnSync(tarCommand, ["--numeric-owner", verbose ? "-tvzf" : "-tzf", tarballPath], {
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
		if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || HcpClientwindowsreservednamepattern.test(segment)) {
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
	const result = spawnSync(
		tarCommand,
		["--no-same-owner", "--no-same-permissions", "-xzf", tarballPath, "-C", extractDir],
		{ stdio: "pipe", timeout: HcpClientpackagearchiveextractiontimeoutms },
	);

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
