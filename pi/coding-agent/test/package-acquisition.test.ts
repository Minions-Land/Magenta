import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HcpClientacquiregithubpackage as acquireGitHubPackage,
	HcpClientdiscoverofficialpackages as discoverOfficialPackages,
	HcpClientgetpackagecacheroot as getPackageCacheRoot,
	HcpClientgetpackageplatformid as getPackagePlatformId,
	HcpClientparsegithubpackageselector as parseGitHubPackageSelector,
} from "../src/utils/package-acquisition.ts";

type TestPackageSelector = {
	owner: string;
	repo: string;
	package: string;
	version: string;
};

function packageManifest(selector: TestPackageSelector): string {
	return [
		'schema_version = "magenta.package.v2"',
		`id = ${JSON.stringify(selector.package)}`,
		`name = ${JSON.stringify(selector.package)}`,
		`version = ${JSON.stringify(selector.version)}`,
		`source = ${JSON.stringify(selector.package)}`,
		"",
	].join("\n");
}

function packageArtifactName(selector: TestPackageSelector): string {
	return `${selector.package}-v${selector.version}-${getPackagePlatformId()}.tar.gz`;
}

function createReleaseArchive(selector: TestPackageSelector, manifest = packageManifest(selector)) {
	const stageDir = mkdtempSync(join(tmpdir(), "magenta-acq-stage-"));
	const pkgDir = join(stageDir, selector.package);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.toml"), manifest);
	const artifact = packageArtifactName(selector);
	const tarballPath = join(stageDir, artifact);
	const tarResult = spawnSync("tar", ["czf", tarballPath, "-C", stageDir, selector.package], { stdio: "pipe" });
	if (tarResult.status !== 0) {
		throw new Error(`Failed to build test archive: ${tarResult.stderr?.toString() ?? "unknown tar error"}`);
	}
	const tarballBytes = readFileSync(tarballPath);
	const expectedHash = createHash("sha256").update(tarballBytes).digest("hex");
	return {
		stageDir,
		tarballBytes,
		checksumBody: `${expectedHash}  ${artifact}\n`,
	};
}

function mockReleaseDownloads(tarballBytes: Uint8Array, checksumBody: string) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url.endsWith(".sha256")) return new Response(checksumBody, { status: 200 });
		if (url.endsWith(".tar.gz")) return new Response(tarballBytes, { status: 200 });
		return new Response(null, { status: 404 });
	});
}

function checksumForArchive(selector: TestPackageSelector, tarballBytes: Uint8Array): string {
	const artifact = packageArtifactName(selector);
	return `${createHash("sha256").update(tarballBytes).digest("hex")}  ${artifact}\n`;
}

function createRawTarGz(
	entries: Array<{ name: string; type: "0" | "2" | "5"; content?: string; linkName?: string }>,
): Buffer {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const content = entry.type === "0" ? Buffer.from(entry.content ?? "") : Buffer.alloc(0);
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf-8");
		header.write("0000644\0", 100, 8, "ascii");
		header.write("0000000\0", 108, 8, "ascii");
		header.write("0000000\0", 116, 8, "ascii");
		header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
		header.write("00000000000\0", 136, 12, "ascii");
		header.fill(0x20, 148, 156);
		header.write(entry.type, 156, 1, "ascii");
		if (entry.linkName) header.write(entry.linkName, 157, 100, "utf-8");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
		header[154] = 0;
		header[155] = 0x20;
		chunks.push(header, content);
		const remainder = content.length % 512;
		if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
	}
	chunks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(chunks));
}

describe("parseGitHubPackageSelector", () => {
	it("parses a well-formed github selector", () => {
		expect(parseGitHubPackageSelector("github:Minions-Land/MagentaPackages/AutOmicScience@1.0.0")).toEqual({
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "AutOmicScience",
			version: "1.0.0",
		});
	});

	it("parses a semver with pre-release and build metadata", () => {
		expect(parseGitHubPackageSelector("github:owner/repo/Pkg@0.1.0-beta.1")).toMatchObject({
			package: "Pkg",
			version: "0.1.0-beta.1",
		});
		expect(parseGitHubPackageSelector("github:owner/.github/Pkg@1.0.0+darwin.arm64")).toMatchObject({
			repo: ".github",
			version: "1.0.0+darwin.arm64",
		});
	});

	it("parses optional package profiles without changing the release version", () => {
		expect(
			parseGitHubPackageSelector("github:Minions-Land/MagentaPackages/AutOmicScience@1.0.0:single-cell,spatial"),
		).toMatchObject({
			package: "AutOmicScience",
			version: "1.0.0",
			profiles: ["single-cell", "spatial"],
		});
	});

	it("returns undefined for a non-github selector", () => {
		expect(parseGitHubPackageSelector("AutOmicScience")).toBeUndefined();
		expect(parseGitHubPackageSelector("AutOmicScience:single-cell")).toBeUndefined();
	});

	it("returns undefined for a malformed github selector", () => {
		expect(parseGitHubPackageSelector("github:owner/repo/Pkg")).toBeUndefined();
		expect(parseGitHubPackageSelector("github:owner/Pkg@1.0.0")).toBeUndefined();
		expect(parseGitHubPackageSelector("github:")).toBeUndefined();
	});

	it("rejects unsafe path segments and non-strict versions", () => {
		const invalidSelectors = [
			"github:-owner/repo/Pkg@1.0.0",
			"github:CON/repo/Pkg@1.0.0",
			"github:owner/repo/Pkg/../../victim@1.0.0",
			"github:owner/repo/Pkg\\victim@1.0.0",
			"github:owner/repo/CON@1.0.0",
			"github:owner/repo./Pkg@1.0.0",
			"github:owner/repo/Pkg@../1.0.0",
			"github:owner/repo/Pkg@v1.0.0",
			"github:owner/repo/Pkg@01.0.0",
			"github:owner/repo/Pkg@1.0.0:../outside",
		];
		for (const selector of invalidSelectors) {
			expect(parseGitHubPackageSelector(selector), selector).toBeUndefined();
		}
	});
});

describe("getPackageCacheRoot", () => {
	it("points under ~/.magenta/harness-packages", () => {
		expect(getPackageCacheRoot()).toMatch(/\.magenta[/\\]harness-packages$/);
	});
});

describe("discoverOfficialPackages", () => {
	it("uses the project's truthy offline semantics", async () => {
		const fetchMock = vi.fn(async () => Response.json([]));
		try {
			vi.stubEnv("PI_OFFLINE", "0");
			const onlineResult = await discoverOfficialPackages({ fetch: fetchMock });
			expect(onlineResult.packages).toEqual([]);
			expect(fetchMock).toHaveBeenCalledOnce();

			fetchMock.mockClear();
			vi.stubEnv("PI_OFFLINE", "true");
			const offlineResult = await discoverOfficialPackages({ fetch: fetchMock });
			expect(offlineResult.diagnostics).toContainEqual(
				expect.objectContaining({ code: "package_catalog_offline", type: "info" }),
			);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("returns the newest release that has a verified artifact pair for this platform", async () => {
		const platformId = getPackagePlatformId();
		const release = (tag: string, assets: string[], extra: Record<string, unknown> = {}) => ({
			tag_name: tag,
			name: tag,
			published_at: "2026-07-13T00:00:00Z",
			draft: false,
			prerelease: false,
			assets: assets.map((name) => ({ name })),
			...extra,
		});
		const artifact = (version: string) => `ClaudeScience-v${version}-${platformId}.tar.gz`;
		const fetchMock = vi.fn(async () =>
			Response.json([
				release("ClaudeScience-v0.1.0", [artifact("0.1.0"), `${artifact("0.1.0")}.sha256`]),
				release("ClaudeScience-v0.2.0", [artifact("0.2.0"), `${artifact("0.2.0")}.sha256`]),
				release("ClaudeScience-v0.3.0", [artifact("0.3.0")]),
				release(
					"Biomni-v0.1.0",
					[`Biomni-v0.1.0-${platformId}.tar.gz`, `Biomni-v0.1.0-${platformId}.tar.gz.sha256`],
					{ draft: true },
				),
			]),
		);

		const result = await discoverOfficialPackages({ fetch: fetchMock });

		expect(result.packages).toEqual([
			expect.objectContaining({
				package: "ClaudeScience",
				version: "0.2.0",
				selector: "github:Minions-Land/Magenta-CLI/ClaudeScience@0.2.0",
			}),
		]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "package_catalog_assets_missing", type: "warning" }),
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/Minions-Land/Magenta-CLI/releases?per_page=100",
			expect.objectContaining({
				headers: expect.objectContaining({ "User-Agent": "Magenta-Package-Catalog" }),
			}),
		);
	});

	it("reports GitHub catalog failures without throwing", async () => {
		const result = await discoverOfficialPackages({
			fetch: async () => new Response(null, { status: 503, statusText: "Unavailable" }),
		});

		expect(result.packages).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "package_catalog_http_error",
				type: "warning",
				message: expect.stringContaining("503 Unavailable"),
			}),
		]);
	});

	it("times out a stalled GitHub catalog request", async () => {
		vi.useFakeTimers();
		try {
			const pending = discoverOfficialPackages({
				fetch: (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("catalog request aborted")));
					}),
			});
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await pending;

			expect(result.packages).toEqual([]);
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
					code: "package_catalog_failed",
					type: "warning",
					message: expect.stringContaining("catalog request aborted"),
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("acquireGitHubPackage caching", () => {
	let cacheRoot: string;

	beforeEach(() => {
		cacheRoot = mkdtempSync(join(tmpdir(), "magenta-acq-cache-"));
		// Redirect the cache root to our temp dir by stubbing HOME so that
		// getPackageCacheRoot() resolves into an isolated location.
		vi.stubEnv("HOME", cacheRoot);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cacheRoot, { recursive: true, force: true });
	});

	it("does not trust a legacy cache entry that has no provenance", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "AutOmicScience",
			version: "1.0.0",
		};
		// Pre-populate the origin-scoped cache with a valid-looking manifest but no
		// provenance marker. It must be discarded rather than treated as verified.
		const cacheDir = join(
			cacheRoot,
			".magenta",
			"harness-packages",
			"github",
			"minions-land",
			"magentapackages",
			"AutOmicScience@1.0.0",
			getPackagePlatformId(),
		);
		const packageRoot = join(cacheDir, "AutOmicScience");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "package.toml"), packageManifest(selector));

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" }));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics.some((d) => d.type === "warning" && /provenance/i.test(d.message))).toBe(true);
			expect(result.diagnostics.some((d) => d.type === "error")).toBe(true);
			expect(fetchSpy).toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("re-downloads when a cache dir exists but is missing package.toml", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "Biomni",
			version: "0.1.0",
		};
		// Cache dir exists with the package folder but no package.toml -> treated
		// as incomplete. Mock fetch so the re-download attempt fails deterministically
		// offline; we assert the loader detected the incomplete cache and did not
		// silently return it as valid.
		const cacheDir = join(
			cacheRoot,
			".magenta",
			"harness-packages",
			"github",
			"minions-land",
			"magentapackages",
			"Biomni@0.1.0",
			getPackagePlatformId(),
		);
		const packageRoot = join(cacheDir, "Biomni");
		mkdirSync(packageRoot, { recursive: true });

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" }));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			// It attempted a fresh download (which fails) rather than returning the
			// incomplete cache as valid.
			expect(result.diagnostics.some((d) => d.type === "error")).toBe(true);
			expect(fetchSpy).toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("downloads, verifies checksum, and extracts a real tarball offline", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "ClaudeScience",
			version: "0.1.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((d) => d.type === "error")).toEqual([]);
			expect(result.cached).toBe(false);
			expect(existsSync(join(result.packageRoot, "package.toml"))).toBe(true);
			expect(existsSync(join(dirname(result.packageRoot), ".magenta-package-provenance.json"))).toBe(true);

			// A second call should now hit the cache without fetching.
			fetchSpy.mockClear();
			const cachedResult = await acquireGitHubPackage(selector);
			expect(cachedResult.cached).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("requests the release artifact for the current Magenta platform", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "PlatformPackage",
			version: "1.0.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			const artifact = packageArtifactName(selector);
			expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
				expect.stringContaining(`/${artifact}`),
				expect.stringContaining(`/${artifact}.sha256`),
			]);
			expect(result.packageRoot).toContain(getPackagePlatformId());
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("rejects an unsafe selector passed directly without touching the cache", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const result = await acquireGitHubPackage({
				owner: "Minions-Land",
				repo: "MagentaPackages",
				package: "../victim",
				version: "1.0.0/../../outside",
			});
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", code: "package_selector_invalid" }),
			);
			const malformedShape = await acquireGitHubPackage({
				owner: "Minions-Land",
				repo: "MagentaPackages",
				package: "SafePackage",
				version: "1.0.0",
				profiles: "not-an-array",
			} as unknown as Parameters<typeof acquireGitHubPackage>[0]);
			expect(malformedShape.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", code: "package_selector_invalid" }),
			);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(existsSync(getPackageCacheRoot())).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("deduplicates concurrent acquisition of the same selector", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "ConcurrentPackage",
			version: "1.0.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const results = await Promise.all([
				acquireGitHubPackage(selector),
				acquireGitHubPackage(selector),
				acquireGitHubPackage(selector),
			]);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(new Set(results.map((result) => result.packageRoot)).size).toBe(1);
			expect(results.every((result) => result.diagnostics.every((diagnostic) => diagnostic.type !== "error"))).toBe(
				true,
			);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("waits for an external process lock before inspecting or replacing the cache", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "ExternallyLocked",
			version: "1.0.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		const lockTarget = join(
			cacheRoot,
			".magenta",
			"harness-packages",
			"github",
			"minions-land",
			"magentapackages",
			`${selector.package}@${selector.version}`,
			`.${getPackagePlatformId()}.acquire`,
		);
		mkdirSync(dirname(lockTarget), { recursive: true });
		writeFileSync(lockTarget, "");
		const releaseExternalLock = await lockfile.lock(lockTarget, { realpath: false });
		try {
			const acquisition = acquireGitHubPackage(selector);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(fetchSpy).not.toHaveBeenCalled();
			await releaseExternalLock();
			const result = await acquisition;
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			try {
				await releaseExternalLock();
			} catch {}
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("rejects tar traversal entries before extraction", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "TraversalPackage",
			version: "1.0.0",
		};
		const tarballBytes = createRawTarGz([
			{ name: `${selector.package}/../../escaped.txt`, type: "0", content: "escaped" },
		]);
		const fetchSpy = mockReleaseDownloads(tarballBytes, checksumForArchive(selector, tarballBytes));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics.some((d) => d.type === "error" && /archive|tar/i.test(d.message))).toBe(true);
			expect(existsSync(result.packageRoot)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects symlink archive entries before extraction", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "SymlinkPackage",
			version: "1.0.0",
		};
		const tarballBytes = createRawTarGz([
			{ name: `${selector.package}/`, type: "5" },
			{ name: `${selector.package}/outside`, type: "2", linkName: "../../outside" },
		]);
		const fetchSpy = mockReleaseDownloads(tarballBytes, checksumForArchive(selector, tarballBytes));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics.some((d) => d.type === "error" && /unsupported type/i.test(d.message))).toBe(true);
			expect(existsSync(result.packageRoot)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it.each([
		{
			label: "an exact duplicate path",
			packageName: "DuplicatePathPackage",
			paths: ["duplicate.txt", "duplicate.txt"],
		},
		{
			label: "a case-insensitive path collision",
			packageName: "CaseCollisionPackage",
			paths: ["Tool.txt", "tool.txt"],
		},
		{
			label: "a Unicode-normalization path collision",
			packageName: "UnicodeCollisionPackage",
			paths: ["caf\u00e9.txt", "cafe\u0301.txt"],
		},
	])("rejects a package archive containing $label", async ({ packageName, paths }) => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: packageName,
			version: "1.0.0",
		};
		const tarballBytes = createRawTarGz([
			{ name: `${selector.package}/`, type: "5" },
			...paths.map((path) => ({ name: `${selector.package}/${path}`, type: "0" as const, content: path })),
		]);
		const fetchSpy = mockReleaseDownloads(tarballBytes, checksumForArchive(selector, tarballBytes));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/duplicate|collide/i) }),
			);
			expect(existsSync(result.packageRoot)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it.each([
		{ label: "a colon path segment", packageName: "ColonPathPackage", path: "stream:name.txt" },
		{ label: "a trailing-dot path segment", packageName: "TrailingDotPathPackage", path: "alias." },
		{ label: "a trailing-space path segment", packageName: "TrailingSpacePathPackage", path: "alias " },
		{ label: "a Windows reserved path segment", packageName: "ReservedPathPackage", path: "CON.txt" },
	])("rejects a package archive containing $label", async ({ packageName, path }) => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: packageName,
			version: "1.0.0",
		};
		const tarballBytes = createRawTarGz([
			{ name: `${selector.package}/`, type: "5" },
			{ name: `${selector.package}/${path}`, type: "0", content: path },
		]);
		const fetchSpy = mockReleaseDownloads(tarballBytes, checksumForArchive(selector, tarballBytes));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/cross-platform safe/i) }),
			);
			expect(existsSync(result.packageRoot)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("scopes identical package versions by GitHub owner and repository", async () => {
		const firstSelector = {
			owner: "First-Org",
			repo: "Packages",
			package: "SharedPackage",
			version: "1.2.3",
		};
		const secondSelector = { ...firstSelector, owner: "Second-Org" };
		const release = createReleaseArchive(firstSelector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const first = await acquireGitHubPackage(firstSelector);
			const second = await acquireGitHubPackage(secondSelector);
			expect(first.diagnostics.filter((d) => d.type === "error")).toEqual([]);
			expect(second.diagnostics.filter((d) => d.type === "error")).toEqual([]);
			expect(first.packageRoot).not.toBe(second.packageRoot);
			expect(first.packageRoot).toContain(join("github", "first-org", "packages"));
			expect(second.packageRoot).toContain(join("github", "second-org", "packages"));
			expect(fetchSpy).toHaveBeenCalledTimes(4);

			fetchSpy.mockClear();
			expect((await acquireGitHubPackage(firstSelector)).cached).toBe(true);
			expect((await acquireGitHubPackage(secondSelector)).cached).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("rejects a downloaded release whose manifest identity is wrong", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "ExpectedPackage",
			version: "1.0.0",
		};
		const release = createReleaseArchive(selector, packageManifest({ ...selector, package: "DifferentPackage" }));
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics.some((d) => d.type === "error" && /id/i.test(d.message))).toBe(true);
			expect(existsSync(result.packageRoot)).toBe(false);
			expect(existsSync(join(dirname(result.packageRoot), ".magenta-package-provenance.json"))).toBe(false);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("rejects a cached package whose manifest no longer matches the selector", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "CorruptManifest",
			version: "2.0.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const installed = await acquireGitHubPackage(selector);
			expect(installed.diagnostics.filter((d) => d.type === "error")).toEqual([]);
			writeFileSync(join(installed.packageRoot, "package.toml"), packageManifest({ ...selector, version: "9.9.9" }));

			fetchSpy.mockClear();
			const repaired = await acquireGitHubPackage(selector);
			expect(repaired.cached).toBe(false);
			expect(repaired.diagnostics.some((d) => d.type === "warning" && /version/i.test(d.message))).toBe(true);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(readFileSync(join(repaired.packageRoot, "package.toml"), "utf-8")).toContain('version = "2.0.0"');
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("rejects a cached package whose provenance names another origin", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "CorruptProvenance",
			version: "3.0.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const installed = await acquireGitHubPackage(selector);
			const provenancePath = join(dirname(installed.packageRoot), ".magenta-package-provenance.json");
			const provenance = JSON.parse(readFileSync(provenancePath, "utf-8")) as Record<string, unknown>;
			writeFileSync(provenancePath, `${JSON.stringify({ ...provenance, repo: "other-repo" }, null, 2)}\n`);

			fetchSpy.mockClear();
			const repaired = await acquireGitHubPackage(selector);
			expect(repaired.cached).toBe(false);
			expect(repaired.diagnostics.some((d) => d.type === "warning" && /provenance/i.test(d.message))).toBe(true);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("does not trust a cached package root replaced by a symlink or junction", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "LinkedCachePackage",
			version: "1.0.0",
		};
		const cacheDir = join(
			cacheRoot,
			".magenta",
			"harness-packages",
			"github",
			"minions-land",
			"magentapackages",
			`${selector.package}@${selector.version}`,
			getPackagePlatformId(),
		);
		const outsidePackage = join(cacheRoot, "outside-linked-package");
		mkdirSync(cacheDir, { recursive: true });
		mkdirSync(outsidePackage, { recursive: true });
		writeFileSync(join(outsidePackage, "package.toml"), packageManifest(selector));
		symlinkSync(outsidePackage, join(cacheDir, selector.package), platform() === "win32" ? "junction" : "dir");
		writeFileSync(
			join(cacheDir, ".magenta-package-provenance.json"),
			`${JSON.stringify(
				{
					schemaVersion: 2,
					source: "github",
					owner: selector.owner.toLowerCase(),
					repo: selector.repo.toLowerCase(),
					package: selector.package,
					version: selector.version,
					platform: getPackagePlatformId(),
					artifact: packageArtifactName(selector),
					artifactSha256: "0".repeat(64),
				},
				null,
				2,
			)}\n`,
		);

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" }));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "warning", message: expect.stringMatching(/cache.*(escapes|real)/i) }),
			);
			expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "error" }));
			expect(readFileSync(join(outsidePackage, "package.toml"), "utf-8")).toContain('id = "LinkedCachePackage"');
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects a tarball whose checksum does not match", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "PantheonOS",
			version: "0.1.0",
		};
		const stageDir = mkdtempSync(join(tmpdir(), "magenta-acq-bad-"));
		const pkgDir = join(stageDir, "PantheonOS");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.toml"), 'id = "PantheonOS"\n');
		const artifact = packageArtifactName(selector);
		const tarballPath = join(stageDir, artifact);
		spawnSync("tar", ["czf", tarballPath, "-C", stageDir, "PantheonOS"], { stdio: "pipe" });
		const tarballBytes = readFileSync(tarballPath);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith(".sha256")) {
				return new Response(`${"0".repeat(64)}  ${artifact}\n`, { status: 200 });
			}
			if (url.endsWith(".tar.gz")) {
				return new Response(new Uint8Array(tarballBytes), { status: 200 });
			}
			return new Response(null, { status: 404 });
		});
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.some((d) => d.type === "error" && /mismatch/i.test(d.message))).toBe(true);
			// A failed acquisition must not leave a usable cache behind.
			expect(existsSync(join(result.packageRoot, "package.toml"))).toBe(false);
		} finally {
			fetchSpy.mockRestore();
			rmSync(stageDir, { recursive: true, force: true });
		}
	});
});
