import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HcpClientacquiregithubpackage as acquireGitHubPackage,
	HcpClientdiscoverofficialpackages as discoverOfficialPackages,
	HcpClientdownloadpackagefile as downloadPackageFile,
	HcpClientgetpackagecacheroot as getPackageCacheRoot,
	HcpClientgetpackageplatformid as getPackagePlatformId,
	HcpClientparsegithubpackageselector as parseGitHubPackageSelector,
	HcpClientparsepackagetarverboseentrysize as parsePackageTarVerboseEntrySize,
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

function createReleaseArchive(
	selector: TestPackageSelector,
	manifest = packageManifest(selector),
	files: Record<string, string | Uint8Array> = {},
) {
	const stageDir = mkdtempSync(join(tmpdir(), "magenta-acq-stage-"));
	const pkgDir = join(stageDir, selector.package);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.toml"), manifest);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = join(pkgDir, relativePath);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, content);
	}
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

function createSparseReleaseArchive(selector: TestPackageSelector, sparseFileBytes: number) {
	const stageDir = mkdtempSync(join(tmpdir(), "magenta-acq-sparse-stage-"));
	const pkgDir = join(stageDir, selector.package);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.toml"), packageManifest(selector));
	const sparseFile = join(pkgDir, "sparse.bin");
	writeFileSync(sparseFile, "");
	truncateSync(sparseFile, sparseFileBytes);
	const artifact = packageArtifactName(selector);
	const tarballPath = join(stageDir, artifact);
	const tarVersion = spawnSync("tar", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	const tarArgs = /GNU tar/i.test(tarVersion.stdout ?? "")
		? ["--sparse", "-czf", tarballPath, "-C", stageDir, selector.package]
		: ["czf", tarballPath, "-C", stageDir, selector.package];
	const tarResult = spawnSync("tar", tarArgs, { stdio: "pipe" });
	if (tarResult.status !== 0) {
		throw new Error(`Failed to build sparse test archive: ${tarResult.stderr?.toString() ?? "unknown tar error"}`);
	}
	if (statSync(tarballPath).size > 16 * 1024 * 1024) {
		throw new Error("Test tar implementation did not encode the sparse fixture compactly");
	}
	const tarballBytes = readFileSync(tarballPath);
	return {
		stageDir,
		tarballBytes,
		checksumBody: checksumForArchive(selector, tarballBytes),
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

function packageVersionDirectory(selector: TestPackageSelector): string {
	return join(
		getPackageCacheRoot(),
		"github",
		selector.owner.toLowerCase(),
		selector.repo.toLowerCase(),
		`${selector.package}@${selector.version}`,
	);
}

function packageLockSentinel(selector: TestPackageSelector): string {
	return join(packageVersionDirectory(selector), `.${getPackagePlatformId()}.acquire`);
}

function writeOwnedStagingMarker(stagingDir: string, selector: TestPackageSelector): void {
	writeFileSync(
		join(stagingDir, ".magenta-package-staging.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				source: "github",
				owner: selector.owner.toLowerCase(),
				repo: selector.repo.toLowerCase(),
				package: selector.package,
				version: selector.version,
				platform: getPackagePlatformId(),
				stagingDirectory: basename(stagingDir),
			},
			null,
			2,
		)}\n`,
	);
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

describe("parsePackageTarVerboseEntrySize", () => {
	it("parses stable bsdtar and GNU tar numeric-owner listings", () => {
		expect(
			parsePackageTarVerboseEntrySize(
				"-rw-r--r--  0 501    20      12345 Jul 23 06:10 Package/sub dir/file.bin",
				"Package/sub dir/file.bin",
			),
		).toBe(12_345);
		expect(
			parsePackageTarVerboseEntrySize(
				"-rw-r--r-- 0/0 67890 2026-07-23 06:10 Package/sub dir/file.bin",
				"Package/sub dir/file.bin",
			),
		).toBe(67_890);
	});

	it("rejects ambiguous verbose listings instead of guessing a size", () => {
		expect(() => parsePackageTarVerboseEntrySize("unexpected Package/file.bin", "Package/file.bin")).toThrow(
			/unsupported format/i,
		);
		expect(() =>
			parsePackageTarVerboseEntrySize("-rw-r--r-- 0/0 1 2026-07-23 06:10 Other/file.bin", "Package/file.bin"),
		).toThrow(/does not match/i);
	});
});

describe("getPackageCacheRoot", () => {
	it("points under ~/.magenta/harness-packages", () => {
		expect(getPackageCacheRoot()).toMatch(/\.magenta[/\\]harness-packages$/);
	});

	it("follows the configured Magenta agent root", () => {
		const previous = process.env.MAGENTA_CODING_AGENT_DIR;
		const configuredAgentDir = join(tmpdir(), "custom-magenta-state", "agent");
		process.env.MAGENTA_CODING_AGENT_DIR = configuredAgentDir;
		try {
			expect(getPackageCacheRoot()).toBe(join(dirname(configuredAgentDir), "harness-packages"));
		} finally {
			if (previous === undefined) delete process.env.MAGENTA_CODING_AGENT_DIR;
			else process.env.MAGENTA_CODING_AGENT_DIR = previous;
		}
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
					"DraftFixture-v0.1.0",
					[`DraftFixture-v0.1.0-${platformId}.tar.gz`, `DraftFixture-v0.1.0-${platformId}.tar.gz.sha256`],
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

describe("package download transport bounds", () => {
	let downloadRoot: string;

	beforeEach(() => {
		downloadRoot = mkdtempSync(join(tmpdir(), "magenta-package-download-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		rmSync(downloadRoot, { recursive: true, force: true });
	});

	it("retries a transient server failure within the shared deadline", async () => {
		let requestCount = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			requestCount++;
			if (requestCount === 1) {
				return new Response("temporary", { status: 503, statusText: "Unavailable" });
			}
			return new Response("payload", { status: 200 });
		});
		const destination = join(downloadRoot, "asset.bin");
		const download = downloadPackageFile(
			"https://example.test/asset.bin",
			destination,
			1024,
			Date.now() + 60_000,
			"asset.bin",
			{ retryDelayMs: 0 },
		);

		await expect(download).resolves.toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(readFileSync(destination, "utf-8")).toBe("payload");
	});

	it("aborts and retries a response body that exceeds the inactivity timeout", async () => {
		let requestCount = 0;
		let stalledBodyCancelled = false;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			requestCount++;
			if (requestCount === 1) {
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							stalledBodyCancelled = true;
						},
					}),
					{ status: 200 },
				);
			}
			return new Response("payload", { status: 200 });
		});
		const destination = join(downloadRoot, "idle.bin");
		const download = downloadPackageFile(
			"https://example.test/idle.bin",
			destination,
			1024,
			Date.now() + 10 * 60_000,
			"idle.bin",
			{ inactivityTimeoutMs: 10, retryDelayMs: 0 },
		);

		await expect(download).resolves.toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(stalledBodyCancelled).toBe(true);
		expect(readFileSync(destination, "utf-8")).toBe("payload");
	});

	it("shares one wall deadline across the artifact and checksum downloads", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							setTimeout(() => {
								controller.enqueue(new TextEncoder().encode("artifact"));
								controller.close();
							}, 50);
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {},
					}),
					{ status: 200 },
				),
			);
		const deadline = Date.now() + 500;
		const artifactDownload = downloadPackageFile(
			"https://example.test/package.tar.gz",
			join(downloadRoot, "package.tar.gz"),
			1024,
			deadline,
			"package.tar.gz",
			{ inactivityTimeoutMs: 1_000, maxAttempts: 1 },
		);
		await expect(artifactDownload).resolves.toBeUndefined();

		const checksumPath = join(downloadRoot, "package.tar.gz.sha256");
		const checksumDownload = downloadPackageFile(
			"https://example.test/package.tar.gz.sha256",
			checksumPath,
			1024,
			deadline,
			"package.tar.gz.sha256",
			{ inactivityTimeoutMs: 1_000, maxAttempts: 1 },
		);
		await expect(checksumDownload).rejects.toThrow(/shared .*package download deadline/i);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(existsSync(checksumPath)).toBe(false);
	});

	it("does not let retry backoff overrun the total download deadline", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("temporary", { status: 503, statusText: "Unavailable" }));
		const download = downloadPackageFile(
			"https://example.test/deadline.bin",
			join(downloadRoot, "deadline.bin"),
			1024,
			Date.now() + 50,
			"deadline.bin",
			{ inactivityTimeoutMs: 1_000, retryDelayMs: 1_000 },
		);
		await expect(download).rejects.toThrow(/shared .*package download deadline/i);
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	it("does not delete a destination that this attempt did not create", async () => {
		const destination = join(downloadRoot, "existing.bin");
		writeFileSync(destination, "preserve");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("replacement", { status: 200 }));
		await expect(
			downloadPackageFile(
				"https://example.test/existing.bin",
				destination,
				1024,
				Date.now() + 1_000,
				"existing.bin",
				{ maxAttempts: 1 },
			),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(readFileSync(destination, "utf-8")).toBe("preserve");
	});
});

describe("acquireGitHubPackage caching", () => {
	let cacheRoot: string;

	beforeEach(() => {
		cacheRoot = mkdtempSync(join(tmpdir(), "magenta-acq-cache-"));
		// Bind the product's supported state-root override instead of relying on
		// runtime-specific HOME caching behavior inside os.homedir().
		vi.stubEnv("MAGENTA_CODING_AGENT_DIR", join(cacheRoot, ".magenta", "agent"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cacheRoot, { recursive: true, force: true });
	});

	it("does not trust or delete a legacy cache entry when its repair download fails", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "AutOmicScience",
			version: "1.0.0",
		};
		// Pre-populate the origin-scoped cache with a valid-looking manifest but no
		// provenance marker. It must not be trusted or deleted before a replacement exists.
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
			expect(readFileSync(join(packageRoot, "package.toml"), "utf-8")).toBe(packageManifest(selector));
			expect(readdirSync(packageVersionDirectory(selector)).some((name) => name.includes(".generation-"))).toBe(
				false,
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("preserves a dangling direct-cache link and repairs beside it", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "DanglingDirectCache",
			version: "1.0.0",
		};
		const directCache = join(packageVersionDirectory(selector), getPackagePlatformId());
		const missingTarget = join(cacheRoot, "missing-direct-cache-target");
		mkdirSync(dirname(directCache), { recursive: true });
		symlinkSync(missingTarget, directCache, platform() === "win32" ? "junction" : "dir");
		expect(existsSync(directCache)).toBe(false);

		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(lstatSync(directCache).isSymbolicLink()).toBe(true);
			expect(existsSync(missingTarget)).toBe(false);
			expect(result.packageRoot).not.toBe(join(directCache, selector.package));
			expect(basename(dirname(result.packageRoot))).toMatch(
				new RegExp(`^\\.${getPackagePlatformId()}\\.generation-[a-f0-9]{64}$`),
			);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("fails closed when an unknown direct-cache entry appears during download", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "PublishDestinationRace",
			version: "1.0.0",
		};
		const directCache = join(packageVersionDirectory(selector), getPackagePlatformId());
		const release = createReleaseArchive(selector);
		let destinationInjected = false;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith(".sha256")) return new Response(release.checksumBody, { status: 200 });
			if (url.endsWith(".tar.gz")) {
				if (!destinationInjected) {
					destinationInjected = true;
					writeFileSync(directCache, "appeared during download");
				}
				return new Response(release.tarballBytes, { status: 200 });
			}
			return new Response(null, { status: 404 });
		});
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/destination.*invalid/i) }),
			);
			expect(readFileSync(directCache, "utf-8")).toBe("appeared during download");
			expect(readdirSync(packageVersionDirectory(selector)).some((name) => name.includes(".generation-"))).toBe(
				false,
			);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("re-downloads when a cache dir exists but is missing package.toml", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "IncompleteFixture",
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
			"IncompleteFixture@0.1.0",
			getPackagePlatformId(),
		);
		const packageRoot = join(cacheDir, "IncompleteFixture");
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
			expect(existsSync(packageRoot)).toBe(true);
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

	it("rejects an oversized package artifact before creating a cache entry", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "OversizedArtifact",
			version: "1.0.0",
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not consumed", {
				status: 200,
				headers: { "content-length": String(512 * 1024 * 1024 + 1) },
			}),
		);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/exceeding.*limit/i) }),
			);
			expect(existsSync(result.packageRoot)).toBe(false);
			expect(fetchSpy).toHaveBeenCalledOnce();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects an oversized streamed checksum and removes partial staging", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "OversizedChecksum",
			version: "1.0.0",
		};
		const release = createReleaseArchive(selector);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).endsWith(".sha256")) {
				return new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 });
			}
			return new Response(release.tarballBytes, { status: 200 });
		});
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/exceeded.*while streaming/i) }),
			);
			expect(existsSync(result.packageRoot)).toBe(false);
			const versionDirectory = dirname(dirname(result.packageRoot));
			expect(
				existsSync(versionDirectory) &&
					readdirSync(versionDirectory).some((name) => name.includes(".staging-") || name === ".download"),
			).toBe(false);
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

	it("cleans owned crash residue and strictly empty legacy staging for the current cache key", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "StagingCleanup",
			version: "1.0.0",
		};
		const versionDirectory = packageVersionDirectory(selector);
		const stagingPrefix = `.${getPackagePlatformId()}.staging-`;
		const ownedStaging = join(versionDirectory, `${stagingPrefix}111-owned`);
		const emptyLegacyStaging = join(versionDirectory, `${stagingPrefix}222-empty`);
		mkdirSync(ownedStaging, { recursive: true });
		mkdirSync(emptyLegacyStaging, { recursive: true });
		writeOwnedStagingMarker(ownedStaging, selector);
		writeFileSync(join(ownedStaging, "partial-download"), "abandoned");

		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(existsSync(ownedStaging)).toBe(false);
			expect(existsSync(emptyLegacyStaging)).toBe(false);
			expect(
				result.diagnostics.filter((diagnostic) => diagnostic.code === "package_cache_residue_removed"),
			).toHaveLength(2);
			expect(existsSync(packageLockSentinel(selector))).toBe(false);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("preserves non-empty staging without a matching ownership marker", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "UnknownStaging",
			version: "1.0.0",
		};
		const unknownStaging = join(
			packageVersionDirectory(selector),
			`.${getPackagePlatformId()}.staging-333-unverified`,
		);
		mkdirSync(unknownStaging, { recursive: true });
		writeFileSync(join(unknownStaging, "keep.txt"), "not owned by acquisition");
		const outsideStaging = join(cacheRoot, "outside-staging");
		const linkedStaging = join(packageVersionDirectory(selector), `.${getPackagePlatformId()}.staging-444-linked`);
		mkdirSync(outsideStaging, { recursive: true });
		writeFileSync(join(outsideStaging, "keep.txt"), "outside link target");
		symlinkSync(outsideStaging, linkedStaging, platform() === "win32" ? "junction" : "dir");

		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(readFileSync(join(unknownStaging, "keep.txt"), "utf-8")).toBe("not owned by acquisition");
			expect(readFileSync(join(outsideStaging, "keep.txt"), "utf-8")).toBe("outside link target");
			expect(existsSync(linkedStaging)).toBe(true);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "warning",
					code: "package_cache_residue_preserved",
					message: expect.stringMatching(/no matching ownership marker/i),
				}),
			);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("preserves a non-empty legacy lock sentinel instead of treating it as disposable", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "UnknownLockSentinel",
			version: "1.0.0",
		};
		const lockSentinel = packageLockSentinel(selector);
		mkdirSync(dirname(lockSentinel), { recursive: true });
		writeFileSync(lockSentinel, "preserve");

		const release = createReleaseArchive(selector);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(readFileSync(lockSentinel, "utf-8")).toBe("preserve");
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "warning",
					code: "package_cache_residue_preserved",
					message: expect.stringMatching(/lock sentinel/i),
				}),
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
		const lockTarget = packageLockSentinel(selector);
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
			expect(existsSync(lockTarget)).toBe(false);
		} finally {
			try {
				await releaseExternalLock();
			} catch {}
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("rejects an archive with more than the bounded number of logical entries", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "EntryCountLimit",
			version: "1.0.0",
		};
		const tarballBytes = createRawTarGz(
			Array.from({ length: 10_001 }, (_, index) => ({
				name: `${selector.package}/entry-${index.toString().padStart(5, "0")}.txt`,
				type: "0" as const,
			})),
		);
		const fetchSpy = mockReleaseDownloads(tarballBytes, checksumForArchive(selector, tarballBytes));
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/10,?000-entry limit/i) }),
			);
			expect(existsSync(result.packageRoot)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects a sparse archive whose logical file size exceeds the expansion limit", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "SparseExpansionLimit",
			version: "1.0.0",
		};
		const release = createSparseReleaseArchive(selector, 2 * 1024 * 1024 * 1024 + 1);
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ type: "error", message: expect.stringMatching(/expands.*file limit/i) }),
			);
			expect(existsSync(result.packageRoot)).toBe(false);
		} finally {
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
		{ label: "a less-than path segment", packageName: "LessThanPathPackage", path: "input<raw.txt" },
		{ label: "a greater-than path segment", packageName: "GreaterThanPathPackage", path: "raw>output.txt" },
		{ label: "a double-quote path segment", packageName: "QuotePathPackage", path: 'say"hello.txt' },
		{ label: "a pipe path segment", packageName: "PipePathPackage", path: "left|right.txt" },
		{ label: "a question-mark path segment", packageName: "QuestionPathPackage", path: "what?.txt" },
		{ label: "an asterisk path segment", packageName: "AsteriskPathPackage", path: "all*.txt" },
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

	it("repairs an invalid direct cache side-by-side and reuses the immutable generation", async () => {
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
			expect(repaired.packageRoot).not.toBe(installed.packageRoot);
			expect(basename(dirname(repaired.packageRoot))).toMatch(
				new RegExp(`^\\.${getPackagePlatformId()}\\.generation-[a-f0-9]{64}$`),
			);
			expect(readFileSync(join(repaired.packageRoot, "package.toml"), "utf-8")).toContain('version = "2.0.0"');
			expect(readFileSync(join(installed.packageRoot, "package.toml"), "utf-8")).toContain('version = "9.9.9"');

			fetchSpy.mockClear();
			const cachedRepair = await acquireGitHubPackage(selector);
			expect(cachedRepair.cached).toBe(true);
			expect(cachedRepair.packageRoot).toBe(repaired.packageRoot);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("repairs cached package content that no longer matches the verified package tree", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "CorruptComponent",
			version: "2.0.0",
		};
		const componentPath = join("components", "HcpMagnet.js");
		const originalComponent = "export const trusted = true;\n";
		const release = createReleaseArchive(selector, packageManifest(selector), {
			[componentPath]: originalComponent,
		});
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const installed = await acquireGitHubPackage(selector);
			expect(installed.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			writeFileSync(join(installed.packageRoot, componentPath), "export const trusted = false;\n");

			fetchSpy.mockClear();
			const repaired = await acquireGitHubPackage(selector);
			expect(repaired.cached).toBe(false);
			expect(repaired.packageRoot).not.toBe(installed.packageRoot);
			expect(repaired.diagnostics).toContainEqual(
				expect.objectContaining({ type: "warning", message: expect.stringMatching(/content digest mismatch/i) }),
			);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(readFileSync(join(installed.packageRoot, componentPath), "utf-8")).toContain("false");
			expect(readFileSync(join(repaired.packageRoot, componentPath), "utf-8")).toBe(originalComponent);

			fetchSpy.mockClear();
			const cachedRepair = await acquireGitHubPackage(selector);
			expect(cachedRepair.cached).toBe(true);
			expect(cachedRepair.packageRoot).toBe(repaired.packageRoot);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("does not trust a direct cache whose executable content gained another hard link", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "HardLinkedComponent",
			version: "2.0.0",
		};
		const componentPath = join("components", "HcpMagnet.js");
		const componentSource = "export const trusted = true;\n";
		const release = createReleaseArchive(selector, packageManifest(selector), {
			[componentPath]: componentSource,
		});
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const installed = await acquireGitHubPackage(selector);
			expect(installed.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			const installedComponent = join(installed.packageRoot, componentPath);
			const externalHardLink = join(cacheRoot, "component-alias.js");
			linkSync(installedComponent, externalHardLink);

			fetchSpy.mockClear();
			const repaired = await acquireGitHubPackage(selector);
			expect(repaired.cached).toBe(false);
			expect(repaired.packageRoot).not.toBe(installed.packageRoot);
			expect(repaired.diagnostics).toContainEqual(
				expect.objectContaining({ type: "warning", message: expect.stringMatching(/single-link regular file/i) }),
			);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(statSync(installedComponent).nlink).toBe(2);
			expect(readFileSync(externalHardLink, "utf-8")).toBe(componentSource);
			expect(readFileSync(join(repaired.packageRoot, componentPath), "utf-8")).toBe(componentSource);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("preserves an unknown generation collision and publishes to a unique immutable path", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "GenerationCollision",
			version: "1.0.0",
		};
		const versionDirectory = packageVersionDirectory(selector);
		const directPackageRoot = join(versionDirectory, getPackagePlatformId(), selector.package);
		mkdirSync(directPackageRoot, { recursive: true });
		writeFileSync(join(directPackageRoot, "package.toml"), packageManifest(selector));

		const release = createReleaseArchive(selector);
		const artifactSha256 = createHash("sha256").update(release.tarballBytes).digest("hex");
		const collidingGeneration = join(versionDirectory, `.${getPackagePlatformId()}.generation-${artifactSha256}`);
		mkdirSync(join(collidingGeneration, selector.package), { recursive: true });
		writeFileSync(join(collidingGeneration, "keep.txt"), "unknown generation");
		writeFileSync(join(collidingGeneration, selector.package, "package.toml"), packageManifest(selector));
		writeFileSync(join(collidingGeneration, ".magenta-package-provenance.json"), "x".repeat(64 * 1024 + 1));

		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(readFileSync(join(collidingGeneration, "keep.txt"), "utf-8")).toBe("unknown generation");
			expect(statSync(join(collidingGeneration, ".magenta-package-provenance.json")).size).toBe(64 * 1024 + 1);
			expect(basename(dirname(result.packageRoot))).toMatch(
				new RegExp(
					`^\\.${getPackagePlatformId()}\\.generation-${artifactSha256}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`,
				),
			);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "warning",
					code: "package_cache_generation_invalid_preserved",
				}),
			);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("preserves a dangling generation collision and publishes to a unique immutable path", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "DanglingGenerationCollision",
			version: "1.0.0",
		};
		const versionDirectory = packageVersionDirectory(selector);
		const directPackageRoot = join(versionDirectory, getPackagePlatformId(), selector.package);
		mkdirSync(directPackageRoot, { recursive: true });
		writeFileSync(join(directPackageRoot, "package.toml"), packageManifest(selector));

		const release = createReleaseArchive(selector);
		const artifactSha256 = createHash("sha256").update(release.tarballBytes).digest("hex");
		const collidingGeneration = join(versionDirectory, `.${getPackagePlatformId()}.generation-${artifactSha256}`);
		const missingTarget = join(cacheRoot, "missing-generation-target");
		symlinkSync(missingTarget, collidingGeneration, platform() === "win32" ? "junction" : "dir");
		expect(existsSync(collidingGeneration)).toBe(false);

		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(lstatSync(collidingGeneration).isSymbolicLink()).toBe(true);
			expect(existsSync(missingTarget)).toBe(false);
			expect(basename(dirname(result.packageRoot))).toMatch(
				new RegExp(
					`^\\.${getPackagePlatformId()}\\.generation-${artifactSha256}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`,
				),
			);
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("does not let unrelated cache entries hide a valid repair generation", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "GenerationScanNoise",
			version: "1.0.0",
		};
		const versionDirectory = packageVersionDirectory(selector);
		const directPackageRoot = join(versionDirectory, getPackagePlatformId(), selector.package);
		mkdirSync(directPackageRoot, { recursive: true });
		writeFileSync(join(directPackageRoot, "package.toml"), packageManifest(selector));

		const release = createReleaseArchive(selector);
		const artifactSha256 = createHash("sha256").update(release.tarballBytes).digest("hex");
		const occupiedPrimary = join(versionDirectory, `.${getPackagePlatformId()}.generation-${artifactSha256}`);
		mkdirSync(occupiedPrimary, { recursive: true });
		writeFileSync(join(occupiedPrimary, "keep.txt"), "unrelated collision");
		const fetchSpy = mockReleaseDownloads(release.tarballBytes, release.checksumBody);
		try {
			const installed = await acquireGitHubPackage(selector);
			expect(installed.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(basename(dirname(installed.packageRoot))).toMatch(
				new RegExp(
					`^\\.${getPackagePlatformId()}\\.generation-${artifactSha256}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`,
				),
			);
			for (let index = 0; index < 70; index++) {
				writeFileSync(join(versionDirectory, `.unrelated-${index.toString().padStart(2, "0")}`), "");
			}

			fetchSpy.mockClear();
			const cached = await acquireGitHubPackage(selector);
			expect(cached.cached).toBe(true);
			expect(cached.packageRoot).toBe(installed.packageRoot);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(release.stageDir, { recursive: true, force: true });
		}
	});

	it("fails closed instead of downloading when the repair generation budget is exceeded", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "GenerationBudget",
			version: "1.0.0",
		};
		const directPackageRoot = join(packageVersionDirectory(selector), getPackagePlatformId(), selector.package);
		mkdirSync(directPackageRoot, { recursive: true });
		writeFileSync(join(directPackageRoot, "package.toml"), packageManifest(selector));
		for (let index = 0; index < 65; index++) {
			const artifactSha256 = index.toString(16).padStart(64, "0");
			mkdirSync(join(packageVersionDirectory(selector), `.${getPackagePlatformId()}.generation-${artifactSha256}`));
		}
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.cached).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringMatching(/more than 64 repair generations/i),
				}),
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
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
			package: "ChecksumFixture",
			version: "0.1.0",
		};
		const stageDir = mkdtempSync(join(tmpdir(), "magenta-acq-bad-"));
		const pkgDir = join(stageDir, "ChecksumFixture");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.toml"), 'id = "ChecksumFixture"\n');
		const artifact = packageArtifactName(selector);
		const tarballPath = join(stageDir, artifact);
		spawnSync("tar", ["czf", tarballPath, "-C", stageDir, "ChecksumFixture"], { stdio: "pipe" });
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
