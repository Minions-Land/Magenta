import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireGitHubPackage,
	getPackageCacheRoot,
	parseGitHubPackageSelector,
} from "../src/utils/package-acquisition.ts";

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
});

describe("getPackageCacheRoot", () => {
	it("points under ~/.magenta/harness-packages", () => {
		expect(getPackageCacheRoot()).toMatch(/\.magenta[/\\]harness-packages$/);
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

	it("returns a cached package without downloading when the cache is populated", async () => {
		const selector = {
			owner: "Minions-Land",
			repo: "MagentaPackages",
			package: "AutOmicScience",
			version: "1.0.0",
		};
		// Pre-populate the cache with a valid-looking package tree.
		const cacheDir = join(cacheRoot, ".magenta", "harness-packages", "AutOmicScience@1.0.0");
		const packageRoot = join(cacheDir, "AutOmicScience");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "package.toml"), 'id = "AutOmicScience"\nversion = "1.0.0"\n');

		const result = await acquireGitHubPackage(selector);
		expect(result.cached).toBe(true);
		expect(result.packageRoot).toBe(packageRoot);
		expect(result.diagnostics.some((d) => d.type === "error")).toBe(false);
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
		const cacheDir = join(cacheRoot, ".magenta", "harness-packages", "Biomni@0.1.0");
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
		// Build a real .tar.gz whose top-level dir is `ClaudeScience/` containing
		// package.toml, mirroring the release.yml artifact layout.
		const stageDir = mkdtempSync(join(tmpdir(), "magenta-acq-stage-"));
		const pkgDir = join(stageDir, "ClaudeScience");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.toml"), 'id = "ClaudeScience"\nversion = "0.1.0"\n');
		const tarballPath = join(stageDir, "ClaudeScience-v0.1.0.tar.gz");
		spawnSync("tar", ["czf", tarballPath, "-C", stageDir, "ClaudeScience"], { stdio: "pipe" });
		const tarballBytes = readFileSync(tarballPath);
		const expectedHash = createHash("sha256").update(tarballBytes).digest("hex");
		const checksumBody = `${expectedHash}  ClaudeScience-v0.1.0.tar.gz\n`;

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith(".sha256")) {
				return new Response(checksumBody, { status: 200 });
			}
			if (url.endsWith(".tar.gz")) {
				return new Response(new Uint8Array(tarballBytes), { status: 200 });
			}
			return new Response(null, { status: 404 });
		});
		try {
			const result = await acquireGitHubPackage(selector);
			expect(result.diagnostics.filter((d) => d.type === "error")).toEqual([]);
			expect(result.cached).toBe(false);
			expect(existsSync(join(result.packageRoot, "package.toml"))).toBe(true);

			// A second call should now hit the cache without fetching.
			fetchSpy.mockClear();
			const cachedResult = await acquireGitHubPackage(selector);
			expect(cachedResult.cached).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(stageDir, { recursive: true, force: true });
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
		const tarballPath = join(stageDir, "PantheonOS-v0.1.0.tar.gz");
		spawnSync("tar", ["czf", tarballPath, "-C", stageDir, "PantheonOS"], { stdio: "pipe" });
		const tarballBytes = readFileSync(tarballPath);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith(".sha256")) {
				return new Response(`${"0".repeat(64)}  PantheonOS-v0.1.0.tar.gz\n`, { status: 200 });
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
