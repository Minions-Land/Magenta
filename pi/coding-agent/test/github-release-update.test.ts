import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearMirrorCache } from "../src/utils/github-mirror.ts";
import {
	assertPackagedProcessToolsStart,
	assertStagedBinaryStartup,
	checkForUpdate,
	consumePreviousWindowsUpdateError,
	downloadReleaseAsset,
	ensureCurrentReleaseResources,
	getBinaryAssetName,
	getReleaseArchiveExtractArgs,
	getUpdateTransactionResourceNames,
	isRetryableDownloadError,
	lockInstallMutation,
	shouldSkipConcurrentUpdateTransaction,
} from "../src/utils/github-release-update.ts";
import {
	applyResourceUpdateTransaction,
	applyUnixUpdateTransaction,
	buildWindowsUpdateScript,
	currentReleaseResourcesAreValid,
	getInstalledRequiredResourcePaths,
	inspectReleaseResourceArchive,
	NODE_UPDATE_TRANSACTION_FILE_SYSTEM,
	parseReleaseChecksums,
	quotePowerShellLiteral,
	RELEASE_CHECKSUMS_ASSET_NAME,
	RELEASE_RESOURCE_MARKER_NAME,
	RELEASE_RESOURCES_ASSET_NAME,
	RELEASE_UPDATE_JOURNAL_NAME,
	REQUIRED_RESOURCE_PATHS,
	RESOURCE_DIRECTORY_NAMES,
	RESOURCE_FILE_NAMES,
	type ReleaseArchiveEntry,
	recoverInterruptedReleaseUpdateTransaction,
	resolveReleaseAssetPlan,
	shouldUseMirrorForReleaseAsset,
	validateExtractedReleaseResources,
	validateReleaseArchiveEntries,
	verifyReleaseArtifactChecksums,
	verifyReleaseAssetDigest,
} from "../src/utils/github-release-update-support.ts";

const RESOURCE_UPDATE_OPERATION_ID = "a".repeat(32);
const BINARY_UPDATE_OPERATION_ID = "b".repeat(32);
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "magenta-release-update-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeText(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content, "utf8");
}

function makeValidArchiveEntries(): ReleaseArchiveEntry[] {
	return [
		...RESOURCE_DIRECTORY_NAMES.map((name) => ({ path: `${name}/`, type: "directory" as const })),
		...RESOURCE_FILE_NAMES.map((name) => ({ path: name, type: "file" as const })),
		{ path: RELEASE_RESOURCE_MARKER_NAME, type: "file" },
		...REQUIRED_RESOURCE_PATHS.map((path) => ({ path, type: "file" as const })),
	];
}

async function makeValidResourceTree(root: string, version = "0.0.12"): Promise<void> {
	for (const directoryName of RESOURCE_DIRECTORY_NAMES) {
		await mkdir(join(root, directoryName), { recursive: true });
	}
	for (const fileName of RESOURCE_FILE_NAMES) {
		await writeFile(join(root, fileName), `${fileName}\n`, "utf8");
	}
	await writeFile(join(root, RELEASE_RESOURCE_MARKER_NAME), `${JSON.stringify({ version })}\n`, "utf8");
	for (const requiredPath of REQUIRED_RESOURCE_PATHS) {
		await writeText(join(root, ...requiredPath.split("/")), `${requiredPath}\n`);
	}
	await writeText(join(root, "theme", "dark.json"), "{}\n");
	await writeText(join(root, "tools", "read", "read.toml"), 'name = "read"\n');
	await writeText(join(root, "skills", "paper-analysis", "pi", "SKILL.md"), "# Skill\n");
	await writeFile(join(root, "photon_rs_bg.wasm"), new Uint8Array([0, 97, 115, 109]));
}

async function createValidResourceArchive(root: string, version = "0.0.12"): Promise<string> {
	const resourceRoot = join(root, "resources");
	const archivePath = join(root, RELEASE_RESOURCES_ASSET_NAME);
	await mkdir(resourceRoot, { recursive: true });
	await makeValidResourceTree(resourceRoot, version);
	const tarResult = spawnSync(
		process.platform === "win32" ? "tar.exe" : "tar",
		[
			"-czf",
			archivePath,
			"-C",
			resourceRoot,
			...RESOURCE_DIRECTORY_NAMES,
			...RESOURCE_FILE_NAMES,
			RELEASE_RESOURCE_MARKER_NAME,
			"photon_rs_bg.wasm",
		],
		{ encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
	);
	expect(tarResult.status, tarResult.stderr).toBe(0);
	return archivePath;
}

describe("staged process-tools startup verification", () => {
	it("executes the packaged helper and rejects a corrupt executable", async () => {
		const root = await makeTemporaryDirectory();
		const binaryName = process.platform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools";
		const releaseDirectory = join(root, "_magenta", "process-tools", "target", "release");
		const helperPath = join(releaseDirectory, binaryName);
		await mkdir(releaseDirectory, { recursive: true });
		if (process.platform === "win32") {
			await copyFile(process.execPath, helperPath);
		} else {
			await symlink("/usr/bin/true", helperPath);
		}

		expect(() => assertPackagedProcessToolsStart(root)).not.toThrow();

		await rm(helperPath, { force: true });
		await writeFile(helperPath, "not an executable", "utf8");
		if (process.platform !== "win32") await chmod(helperPath, 0o755);
		expect(() => assertPackagedProcessToolsStart(root)).toThrow(/failed to start|failed --help/i);
	});

	it.skipIf(process.platform === "win32")(
		"initializes the staged helper through an isolated offline startup",
		async () => {
			const root = await makeTemporaryDirectory();
			const binaryPath = join(root, "magenta");
			await writeFile(
				binaryPath,
				`#!/bin/sh
set -eu
test "$1" = "--help"
test "$2" = "--offline"
test "$3" = "smoke"
test "$(pwd -P)" = "$(cd "$PI_PACKAGE_DIR" && pwd -P)"
test "$HOME" = "$PI_PACKAGE_DIR/.magenta-smoke-home"
test "$USERPROFILE" = "$HOME"
test "$MAGENTA_CODING_AGENT_DIR" = "$HOME/agent"
test "$MAGENTA_PEER_MESSAGE_DB" = "$HOME/messages.db"
helper_dir="$PI_PACKAGE_DIR/_magenta/process-tools/target/release"
mkdir -p "$helper_dir" "$MAGENTA_CODING_AGENT_DIR"
printf '#!/bin/sh\nexit 0\n' > "$helper_dir/magenta-process-tools"
chmod +x "$helper_dir/magenta-process-tools"
`,
				"utf8",
			);
			await chmod(binaryPath, 0o755);

			expect(() => assertStagedBinaryStartup(binaryPath, root)).not.toThrow();
			expect(existsSync(join(root, ".magenta-smoke-home", "agent"))).toBe(true);
		},
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	_clearMirrorCache();
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("release asset planning", () => {
	it("maps only architectures published by the release workflow", () => {
		expect(getBinaryAssetName("darwin", "arm64")).toBe("magenta-macos-arm64");
		expect(getBinaryAssetName("darwin", "x64")).toBe("magenta-macos-x64");
		expect(getBinaryAssetName("linux", "x64")).toBe("magenta-linux-x64");
		expect(getBinaryAssetName("win32", "x64")).toBe("magenta-windows-x64.exe");

		expect(() => getBinaryAssetName("linux", "arm64")).toThrow(/no published binary for linux arm64/i);
		expect(() => getBinaryAssetName("win32", "arm64")).toThrow(/no published binary for win32 arm64/i);
		expect(() => getBinaryAssetName("freebsd", "x64")).toThrow(/no published binary for freebsd x64/i);
	});

	it("commits the staged process-tools tree with every binary update", () => {
		expect(getUpdateTransactionResourceNames(["theme", RELEASE_RESOURCE_MARKER_NAME])).toEqual([
			"theme",
			RELEASE_RESOURCE_MARKER_NAME,
			"_magenta",
		]);
	});

	it("requires the binary, resources, and checksums from one release response", () => {
		const assets = [
			{ name: "magenta-windows-x64.exe", browser_download_url: "https://example.test/v1/magenta.exe" },
			{ name: RELEASE_RESOURCES_ASSET_NAME, browser_download_url: "https://example.test/v1/resources" },
			{ name: RELEASE_CHECKSUMS_ASSET_NAME, browser_download_url: "https://example.test/v1/checksums" },
		];

		expect(resolveReleaseAssetPlan(assets, "magenta-windows-x64.exe")).toEqual({
			binary: { name: "magenta-windows-x64.exe", downloadUrl: "https://example.test/v1/magenta.exe" },
			resources: { name: RELEASE_RESOURCES_ASSET_NAME, downloadUrl: "https://example.test/v1/resources" },
			checksums: { name: RELEASE_CHECKSUMS_ASSET_NAME, downloadUrl: "https://example.test/v1/checksums" },
		});
	});

	it("preserves a trusted GitHub API SHA-256 digest and rejects malformed digests", () => {
		const sha256 = "A".repeat(64);
		const assets = [
			{
				name: "magenta-linux-x64",
				browser_download_url: "https://example.test/binary",
				digest: `sha256:${sha256}`,
			},
			{ name: RELEASE_RESOURCES_ASSET_NAME, browser_download_url: "https://example.test/resources" },
			{ name: RELEASE_CHECKSUMS_ASSET_NAME, browser_download_url: "https://example.test/checksums" },
		];

		const plan = resolveReleaseAssetPlan(assets, "magenta-linux-x64");
		expect(plan.binary.sha256).toBe(sha256.toLowerCase());
		expect(shouldUseMirrorForReleaseAsset(plan.binary)).toBe(true);
		expect(shouldUseMirrorForReleaseAsset(plan.checksums)).toBe(false);
		expect(shouldUseMirrorForReleaseAsset({ ...plan.checksums, sha256: "" })).toBe(false);
		expect(shouldUseMirrorForReleaseAsset({ ...plan.checksums, sha256: sha256.toLowerCase() })).toBe(true);
		expect(() =>
			resolveReleaseAssetPlan(
				[{ ...assets[0]!, digest: "md5:invalid" }, assets[1]!, assets[2]!],
				"magenta-linux-x64",
			),
		).toThrow(/invalid SHA-256 digest/i);
	});

	it("rejects missing or ambiguous release assets", () => {
		const binary = { name: "magenta-linux-x64", browser_download_url: "https://example.test/binary" };
		const resources = { name: RELEASE_RESOURCES_ASSET_NAME, browser_download_url: "https://example.test/resources" };
		const checksums = { name: RELEASE_CHECKSUMS_ASSET_NAME, browser_download_url: "https://example.test/checksums" };

		expect(() => resolveReleaseAssetPlan([binary, checksums], binary.name)).toThrow(/missing required asset/i);
		expect(() => resolveReleaseAssetPlan([binary, resources, checksums, checksums], binary.name)).toThrow(
			/duplicate assets/i,
		);
	});
});

describe("release checksums", () => {
	it("parses strict sha256sum output and accepts the binary marker", () => {
		const first = "a".repeat(64);
		const second = "B".repeat(64);
		const checksums = parseReleaseChecksums(
			`${first}  magenta-linux-x64\n${second} *${RELEASE_RESOURCES_ASSET_NAME}\n`,
		);

		expect(checksums.get("magenta-linux-x64")).toBe(first);
		expect(checksums.get(RELEASE_RESOURCES_ASSET_NAME)).toBe(second.toLowerCase());
	});

	it.each([
		["malformed", "not-a-checksum  magenta-linux-x64\n"],
		["parent traversal", `${"a".repeat(64)}  ../magenta-linux-x64\n`],
		["backslash", `${"a".repeat(64)}  folder\\magenta-linux-x64\n`],
		["duplicate", `${"a".repeat(64)}  magenta-linux-x64\n${"b".repeat(64)}  magenta-linux-x64\n`],
	])("rejects %s checksum input", (_label, content) => {
		expect(() => parseReleaseChecksums(content)).toThrow();
	});

	it("verifies a downloaded asset against the direct GitHub API digest", async () => {
		const root = await makeTemporaryDirectory();
		const artifactPath = join(root, "artifact");
		await writeText(artifactPath, "trusted bytes");
		const sha256 = createHash("sha256").update("trusted bytes").digest("hex");
		const asset = { name: "artifact", downloadUrl: "https://example.test/artifact", sha256 };

		await expect(verifyReleaseAssetDigest(asset, artifactPath)).resolves.toBe(true);
		await expect(verifyReleaseAssetDigest({ ...asset, sha256: "0".repeat(64) }, artifactPath)).rejects.toThrow(
			/GitHub API digest verification failed/i,
		);
		await expect(
			verifyReleaseAssetDigest({ name: asset.name, downloadUrl: asset.downloadUrl }, artifactPath),
		).resolves.toBe(false);
	});

	it("rejects a mismatched artifact before any installed files are touched", async () => {
		const root = await makeTemporaryDirectory();
		const installedBinary = join(root, "install", "magenta");
		const downloadedBinary = join(root, "download", "magenta-linux-x64");
		await writeText(installedBinary, "old binary");
		await writeText(downloadedBinary, "new binary");
		const wrongChecksum = createHash("sha256").update("different bytes").digest("hex");

		await expect(
			verifyReleaseArtifactChecksums(new Map([["magenta-linux-x64", wrongChecksum]]), [
				{ name: "magenta-linux-x64", path: downloadedBinary },
			]),
		).rejects.toThrow(/checksum verification failed/i);
		expect(await readFile(installedBinary, "utf8")).toBe("old binary");
	});
});

describe("release resource archive validation", () => {
	it("extracts Unix resources as the installing user instead of an archived numeric owner", () => {
		const archivePath = "/tmp/magenta-resources.tar.gz";
		const stagingDirectory = "/tmp/magenta-staging";
		expect(getReleaseArchiveExtractArgs(archivePath, stagingDirectory, "linux")).toEqual([
			"--no-same-owner",
			"-xzf",
			archivePath,
			"-C",
			stagingDirectory,
		]);
		expect(getReleaseArchiveExtractArgs(archivePath, stagingDirectory, "darwin")).toEqual([
			"--no-same-owner",
			"-xzf",
			archivePath,
			"-C",
			stagingDirectory,
		]);
		expect(getReleaseArchiveExtractArgs(archivePath, stagingDirectory, "win32")).toEqual([
			"-xzf",
			archivePath,
			"-C",
			stagingDirectory,
		]);
	});

	it("accepts the complete release resource layout", () => {
		const topLevelNames = validateReleaseArchiveEntries(makeValidArchiveEntries());
		expect(topLevelNames).toEqual(expect.arrayContaining([...RESOURCE_DIRECTORY_NAMES, ...RESOURCE_FILE_NAMES]));
		expect(topLevelNames).toContain("photon_rs_bg.wasm");
	});

	it.each([
		["parent traversal", { path: "tools/../../escape", type: "file" as const }],
		["absolute path", { path: "/tmp/escape", type: "file" as const }],
		["backslash", { path: "tools\\escape", type: "file" as const }],
		["symlink", { path: "tools/link", type: "symlink" as const }],
		["hardlink", { path: "tools/link", type: "hardlink" as const }],
		["unknown root", { path: "magenta-windows-x64.exe", type: "file" as const }],
		["Windows reserved name", { path: "tools/CON.txt", type: "file" as const }],
	])("rejects an archive containing %s", (_label, maliciousEntry) => {
		expect(() => validateReleaseArchiveEntries([...makeValidArchiveEntries(), maliciousEntry])).toThrow();
	});

	it("rejects a universal archive missing a released clipboard binding", () => {
		const missingPath = "runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node";
		expect(() =>
			validateReleaseArchiveEntries(makeValidArchiveEntries().filter((entry) => entry.path !== missingPath)),
		).toThrow(/missing required file/i);
	});

	it("rejects case-insensitive duplicate paths", () => {
		expect(() =>
			validateReleaseArchiveEntries([...makeValidArchiveEntries(), { path: "theme/DARK.json", type: "file" }]),
		).toThrow(/duplicate path/i);
	});

	it("maps installed resource validation to the current platform binding", () => {
		expect(getInstalledRequiredResourcePaths("darwin", "arm64")).toContain(
			"runtime/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node",
		);
		expect(getInstalledRequiredResourcePaths("linux", "x64")).toContain(
			"runtime/node_modules/@mariozechner/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node",
		);
		expect(getInstalledRequiredResourcePaths("win32", "x64")).toContain(
			"runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
		);
	});

	it("parses a real gzip tar and verifies extracted marker files", async () => {
		const root = await makeTemporaryDirectory();
		const resourceRoot = join(root, "resources");
		const archivePath = await createValidResourceArchive(root);

		const topLevelNames = await inspectReleaseResourceArchive(archivePath);
		await expect(validateExtractedReleaseResources(resourceRoot, topLevelNames)).resolves.toBeUndefined();
	});

	it("adds a version marker when repairing resources from a legacy archive", async () => {
		const root = await makeTemporaryDirectory();
		await makeValidResourceTree(root, "0.0.11");
		await rm(join(root, RELEASE_RESOURCE_MARKER_NAME));
		const entries = makeValidArchiveEntries().filter((entry) => entry.path !== RELEASE_RESOURCE_MARKER_NAME);
		const topLevelNames = validateReleaseArchiveEntries(entries);

		await validateExtractedReleaseResources(root, topLevelNames, "0.0.11");
		expect(await readFile(join(root, RELEASE_RESOURCE_MARKER_NAME), "utf8")).toBe('{"version":"0.0.11"}\n');
	});
});

describe("startup resource bootstrap", () => {
	it("repairs resources from the exact current-version release before startup", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "install");
		const archivePath = await createValidResourceArchive(join(root, "release"), "0.0.12");
		const archiveBytes = await readFile(archivePath);
		const archiveChecksum = createHash("sha256").update(archiveBytes).digest("hex");
		await writeText(join(installDirectory, "theme", "dark.json"), "old theme");
		await writeText(join(installDirectory, "other-program"), "do not touch");

		const assetBaseUrl = "https://example.test/releases/download/v0.0.12";
		vi.stubEnv("MAGENTA_GITHUB_MIRROR", "https://untrusted-mirror.example");
		_clearMirrorCache();
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === `${assetBaseUrl}/${RELEASE_CHECKSUMS_ASSET_NAME}`) {
				return new Response(`${archiveChecksum}  ${RELEASE_RESOURCES_ASSET_NAME}\n`);
			}
			if (url === `${assetBaseUrl}/${RELEASE_RESOURCES_ASSET_NAME}`) {
				return new Response(archiveBytes);
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			ensureCurrentReleaseResources({
				force: true,
				installDirectory,
				version: "0.0.12",
				assetBaseUrl,
			}),
		).resolves.toBe(true);

		expect(await readFile(join(installDirectory, RELEASE_RESOURCE_MARKER_NAME), "utf8")).toBe(
			'{"version":"0.0.12"}\n',
		);
		expect(await readFile(join(installDirectory, "theme", "dark.json"), "utf8")).toBe("{}\n");
		expect(await readFile(join(installDirectory, "other-program"), "utf8")).toBe("do not touch");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await expect(
			ensureCurrentReleaseResources({
				force: true,
				installDirectory,
				version: "0.0.12",
				assetBaseUrl,
			}),
		).resolves.toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not continue with mismatched resources in offline mode", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "install");
		await writeText(join(installDirectory, "theme", "dark.json"), "old theme");

		await expect(
			ensureCurrentReleaseResources({
				force: true,
				offline: true,
				installDirectory,
				version: "0.0.12",
			}),
		).rejects.toThrow(/offline prevents repair/i);
		expect(await readFile(join(installDirectory, "theme", "dark.json"), "utf8")).toBe("old theme");
	});

	it("rejects a version-matched resource tree when a required root or WASM asset is missing", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "install");
		await makeValidResourceTree(installDirectory, "0.0.12");

		await rm(join(installDirectory, "policy"), { recursive: true });
		expect(await currentReleaseResourcesAreValid(installDirectory, "0.0.12")).toBe(false);

		await mkdir(join(installDirectory, "policy"));
		await rm(join(installDirectory, "photon_rs_bg.wasm"));
		expect(await currentReleaseResourcesAreValid(installDirectory, "0.0.12")).toBe(false);
	});

	it("rejects installed resources when the current platform clipboard binding is missing", async () => {
		const root = await makeTemporaryDirectory();
		await makeValidResourceTree(root, "0.0.12");
		const nativeBinding = getInstalledRequiredResourcePaths().find((path) => path.endsWith(".node"));
		expect(nativeBinding).toBeDefined();
		await rm(join(root, ...(nativeBinding as string).split("/")));
		expect(await currentReleaseResourcesAreValid(root, "0.0.12")).toBe(false);
	});

	it("rolls back a resource-only startup repair when verification fails", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "install");
		const stagingDirectory = join(installDirectory, `.magenta-resource-staging-${RESOURCE_UPDATE_OPERATION_ID}`);
		const backupDirectory = join(installDirectory, `.magenta-resource-backup-${RESOURCE_UPDATE_OPERATION_ID}`);
		await writeText(join(installDirectory, "theme", "dark.json"), "old theme");
		await writeText(join(installDirectory, RELEASE_RESOURCE_MARKER_NAME), '{"version":"0.0.11"}\n');
		await writeText(join(installDirectory, "other-program"), "do not touch");
		await writeText(join(stagingDirectory, "theme", "dark.json"), "new theme");
		await writeText(join(stagingDirectory, RELEASE_RESOURCE_MARKER_NAME), '{"version":"0.0.12"}\n');

		await expect(
			applyResourceUpdateTransaction({
				installDirectory,
				operationId: RESOURCE_UPDATE_OPERATION_ID,
				stagingDirectory,
				backupDirectory,
				resourceNames: ["theme", RELEASE_RESOURCE_MARKER_NAME],
				verifyInstalled: () => {
					throw new Error("injected marker verification failure");
				},
			}),
		).rejects.toThrow(/previous resources were restored/i);

		expect(await readFile(join(installDirectory, "theme", "dark.json"), "utf8")).toBe("old theme");
		expect(await readFile(join(installDirectory, RELEASE_RESOURCE_MARKER_NAME), "utf8")).toBe(
			'{"version":"0.0.11"}\n',
		);
		expect(await readFile(join(installDirectory, "other-program"), "utf8")).toBe("do not touch");
	});
});

describe("Unix update transaction", () => {
	it("only skips a concurrent same-version install when its resources are complete", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "bin");
		await makeValidResourceTree(installDirectory, "0.0.12");

		await expect(shouldSkipConcurrentUpdateTransaction(installDirectory, "0.0.12", "0.0.12")).resolves.toBe(true);
		await rm(join(installDirectory, "photon_rs_bg.wasm"));
		await expect(shouldSkipConcurrentUpdateTransaction(installDirectory, "0.0.12", "0.0.12")).resolves.toBe(false);
	});

	it("never lets an older concurrent transaction replace a newer incomplete release", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "bin");
		await makeValidResourceTree(installDirectory, "0.0.13");

		await expect(shouldSkipConcurrentUpdateTransaction(installDirectory, "0.0.13", "0.0.12")).resolves.toBe(true);
		await rm(join(installDirectory, RELEASE_RESOURCE_MARKER_NAME));
		await expect(shouldSkipConcurrentUpdateTransaction(installDirectory, "0.0.13", "0.0.12")).rejects.toThrow(
			/newer v0\.0\.13.*resources are incomplete.*older v0\.0\.12/i,
		);
	});

	it("replaces the binary and resources while leaving unrelated programs untouched", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "bin");
		const stagingDirectory = join(installDirectory, `.magenta-update-staging-${BINARY_UPDATE_OPERATION_ID}`);
		const backupDirectory = join(installDirectory, `.magenta-update-backup-${BINARY_UPDATE_OPERATION_ID}`);
		const currentBinary = join(installDirectory, "magenta");
		await mkdir(stagingDirectory, { recursive: true });
		await writeText(currentBinary, "old binary");
		await writeText(join(installDirectory, "theme", "dark.json"), "old theme");
		await writeText(join(installDirectory, "package.json"), "old package");
		await writeText(
			join(installDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
			"old helper",
		);
		await writeText(join(installDirectory, "other-program"), "do not touch");
		await writeText(join(stagingDirectory, "magenta"), "new binary");
		await writeText(join(stagingDirectory, "theme", "dark.json"), "new theme");
		await writeText(join(stagingDirectory, "package.json"), "new package");
		await writeText(
			join(stagingDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
			"new helper",
		);

		const cleanupWarnings = await applyUnixUpdateTransaction({
			currentBinary,
			operationId: BINARY_UPDATE_OPERATION_ID,
			stagingDirectory,
			backupDirectory,
			resourceNames: ["theme", "package.json", "_magenta"],
			verifyInstalled: async () => {
				expect(await readFile(currentBinary, "utf8")).toBe("new binary");
				expect(await readFile(join(installDirectory, "theme", "dark.json"), "utf8")).toBe("new theme");
				expect(
					await readFile(
						join(installDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
						"utf8",
					),
				).toBe("new helper");
			},
		});

		expect(cleanupWarnings).toEqual([]);
		expect(await readFile(currentBinary, "utf8")).toBe("new binary");
		expect(await readFile(join(installDirectory, "package.json"), "utf8")).toBe("new package");
		expect(
			await readFile(
				join(installDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
				"utf8",
			),
		).toBe("new helper");
		expect(await readFile(join(installDirectory, "other-program"), "utf8")).toBe("do not touch");
		expect(existsSync(stagingDirectory)).toBe(false);
		expect(existsSync(backupDirectory)).toBe(false);
	});

	it("restores every old item when a resource rename fails", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "bin");
		const stagingDirectory = join(installDirectory, `.magenta-update-staging-${BINARY_UPDATE_OPERATION_ID}`);
		const backupDirectory = join(installDirectory, `.magenta-update-backup-${BINARY_UPDATE_OPERATION_ID}`);
		const currentBinary = join(installDirectory, "magenta");
		await mkdir(stagingDirectory, { recursive: true });
		await writeText(currentBinary, "old binary");
		await writeText(join(installDirectory, "theme", "dark.json"), "old theme");
		await writeText(join(installDirectory, "other-program"), "do not touch");
		await writeText(join(stagingDirectory, "magenta"), "new binary");
		await writeText(join(stagingDirectory, "theme", "dark.json"), "new theme");
		await writeText(join(stagingDirectory, "package.json"), "new package");

		await expect(
			applyUnixUpdateTransaction({
				currentBinary,
				operationId: BINARY_UPDATE_OPERATION_ID,
				stagingDirectory,
				backupDirectory,
				resourceNames: ["theme", "package.json"],
				verifyInstalled: () => undefined,
				fileSystem: {
					...NODE_UPDATE_TRANSACTION_FILE_SYSTEM,
					async movePath(source, destination) {
						if (source === join(stagingDirectory, "package.json")) {
							throw new Error("injected rename failure");
						}
						await NODE_UPDATE_TRANSACTION_FILE_SYSTEM.movePath(source, destination);
					},
				},
			}),
		).rejects.toThrow(/previous installation was restored/i);

		expect(await readFile(currentBinary, "utf8")).toBe("old binary");
		expect(await readFile(join(installDirectory, "theme", "dark.json"), "utf8")).toBe("old theme");
		expect(existsSync(join(installDirectory, "package.json"))).toBe(false);
		expect(await readFile(join(installDirectory, "other-program"), "utf8")).toBe("do not touch");
	});

	it("rolls back a fully switched update when installed binary verification fails", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "bin");
		const stagingDirectory = join(installDirectory, `.magenta-update-staging-${BINARY_UPDATE_OPERATION_ID}`);
		const backupDirectory = join(installDirectory, `.magenta-update-backup-${BINARY_UPDATE_OPERATION_ID}`);
		const currentBinary = join(installDirectory, "magenta");
		await mkdir(stagingDirectory, { recursive: true });
		await writeText(currentBinary, "old binary");
		await writeText(join(installDirectory, "theme", "dark.json"), "old theme");
		await writeText(
			join(installDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
			"old helper",
		);
		await writeText(join(stagingDirectory, "magenta"), "bad binary");
		await writeText(join(stagingDirectory, "theme", "dark.json"), "new theme");
		await writeText(join(stagingDirectory, "package.json"), "new package");
		await writeText(
			join(stagingDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
			"new helper",
		);

		await expect(
			applyUnixUpdateTransaction({
				currentBinary,
				operationId: BINARY_UPDATE_OPERATION_ID,
				stagingDirectory,
				backupDirectory,
				resourceNames: ["theme", "package.json", "_magenta"],
				verifyInstalled: () => {
					throw new Error("version mismatch");
				},
			}),
		).rejects.toThrow(/previous installation was restored/i);

		expect(await readFile(currentBinary, "utf8")).toBe("old binary");
		expect(await readFile(join(installDirectory, "theme", "dark.json"), "utf8")).toBe("old theme");
		expect(
			await readFile(
				join(installDirectory, "_magenta", "process-tools", "target", "release", "magenta-process-tools"),
				"utf8",
			),
		).toBe("old helper");
		expect(existsSync(join(installDirectory, "package.json"))).toBe(false);
	});

	for (const [index, faultPoint] of [
		"journal:prepared",
		"resource-backup:theme",
		"resource-install:theme",
		"binary-backup:complete",
		"binary-install:complete",
		"verification:complete",
		"journal:committed",
	].entries()) {
		it(`recovers idempotently after a simulated process stop at ${faultPoint}`, async () => {
			const root = await makeTemporaryDirectory();
			const installDirectory = join(root, "bin");
			const operationId = (index + 1).toString(16).padStart(32, "0");
			const stagingDirectory = join(installDirectory, `.magenta-update-staging-${operationId}`);
			const backupDirectory = join(installDirectory, `.magenta-update-backup-${operationId}`);
			const currentBinary = join(installDirectory, "magenta");
			await writeText(currentBinary, "old binary");
			await writeText(join(installDirectory, "theme"), "old theme");
			await writeText(join(installDirectory, "unrelated"), "keep me");
			await writeText(join(stagingDirectory, "magenta"), "new binary");
			await writeText(join(stagingDirectory, "theme"), "new theme");

			await expect(
				applyUnixUpdateTransaction({
					currentBinary,
					operationId,
					stagingDirectory,
					backupDirectory,
					resourceNames: ["theme"],
					verifyInstalled: () => undefined,
					testFaultInjector(point) {
						if (point === faultPoint) throw new Error(`stop at ${point}`);
					},
				}),
			).rejects.toThrow(/stop at/);

			// The executable path is populated before and after the one atomic replacement.
			expect((await lstat(currentBinary)).isFile()).toBe(true);
			if (process.platform !== "win32") {
				expect((await lstat(join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME))).mode & 0o077).toBe(0);
			}
			await expect(recoverInterruptedReleaseUpdateTransaction(installDirectory)).resolves.toBe(true);
			await expect(recoverInterruptedReleaseUpdateTransaction(installDirectory)).resolves.toBe(false);

			const committed = faultPoint === "journal:committed";
			expect(await readFile(currentBinary, "utf8")).toBe(committed ? "new binary" : "old binary");
			expect(await readFile(join(installDirectory, "theme"), "utf8")).toBe(committed ? "new theme" : "old theme");
			expect(await readFile(join(installDirectory, "unrelated"), "utf8")).toBe("keep me");
			expect(existsSync(stagingDirectory)).toBe(false);
			expect(existsSync(backupDirectory)).toBe(false);
			expect(existsSync(join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME))).toBe(false);
		});
	}

	it("uses the durable journal when a same-operation phase temp was fsynced but not renamed", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "bin");
		const operationId = "c".repeat(32);
		const stagingDirectory = join(installDirectory, `.magenta-update-staging-${operationId}`);
		const backupDirectory = join(installDirectory, `.magenta-update-backup-${operationId}`);
		const currentBinary = join(installDirectory, "magenta");
		const journalPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME);
		const temporaryJournalPath = `${journalPath}.tmp`;
		await writeText(currentBinary, "old binary");
		await writeText(join(installDirectory, "theme"), "old theme");
		await writeText(join(stagingDirectory, "magenta"), "new binary");
		await writeText(join(stagingDirectory, "theme"), "new theme");

		await expect(
			applyUnixUpdateTransaction({
				currentBinary,
				operationId,
				stagingDirectory,
				backupDirectory,
				resourceNames: ["theme"],
				verifyInstalled: () => undefined,
				testFaultInjector(point) {
					if (point === "verification:complete") throw new Error("stop before journal phase rename");
				},
			}),
		).rejects.toThrow(/phase rename/);
		const durableJournal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(temporaryJournalPath, `${JSON.stringify({ ...durableJournal, phase: "committed" })}\n`, {
			mode: 0o600,
		});

		await expect(recoverInterruptedReleaseUpdateTransaction(installDirectory)).resolves.toBe(true);
		expect(await readFile(currentBinary, "utf8")).toBe("old binary");
		expect(await readFile(join(installDirectory, "theme"), "utf8")).toBe("old theme");
		expect(existsSync(journalPath)).toBe(false);
		expect(existsSync(temporaryJournalPath)).toBe(false);
	});

	it("fails closed when durable and temporary journals identify different operations", async () => {
		const installDirectory = await makeTemporaryDirectory();
		const durableJournal = {
			version: 1,
			operationId: "d".repeat(32),
			kind: "resources",
			binaryName: null,
			targetVersion: null,
			resourceNames: [],
			originalResourceNames: [],
			phase: "staging",
		};
		const journalPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME);
		await writeFile(journalPath, `${JSON.stringify(durableJournal)}\n`, { mode: 0o600 });
		await writeFile(`${journalPath}.tmp`, `${JSON.stringify({ ...durableJournal, operationId: "e".repeat(32) })}\n`, {
			mode: 0o600,
		});

		await expect(recoverInterruptedReleaseUpdateTransaction(installDirectory)).rejects.toThrow(/disagree/i);
		expect(existsSync(journalPath)).toBe(true);
		expect(existsSync(`${journalPath}.tmp`)).toBe(true);
	});

	it("fails closed on a corrupted journal without touching unrelated paths", async () => {
		const installDirectory = await makeTemporaryDirectory();
		await writeText(join(installDirectory, "unrelated"), "keep me");
		await writeFile(join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME), "{broken", { mode: 0o600 });

		await expect(recoverInterruptedReleaseUpdateTransaction(installDirectory)).rejects.toThrow(/corrupted/i);
		expect(await readFile(join(installDirectory, "unrelated"), "utf8")).toBe("keep me");
	});

	it.skipIf(process.platform === "win32")("refuses to recover through a journal symlink", async () => {
		const root = await makeTemporaryDirectory();
		const installDirectory = join(root, "install");
		await mkdir(installDirectory);
		const external = join(root, "external-journal");
		await writeFile(external, "do not touch", { mode: 0o600 });
		await symlink(external, join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME));

		await expect(recoverInterruptedReleaseUpdateTransaction(installDirectory)).rejects.toThrow(/symbolic link/i);
		expect(await readFile(external, "utf8")).toBe("do not touch");
	});

	it("serializes mutations for the same installation target", async () => {
		const installDirectory = await makeTemporaryDirectory();
		const releaseFirst = await lockInstallMutation(installDirectory, { retries: 0 });
		try {
			await expect(lockInstallMutation(installDirectory, { retries: 0 })).rejects.toMatchObject({ code: "ELOCKED" });
		} finally {
			await releaseFirst();
		}
		const releaseSecond = await lockInstallMutation(installDirectory, { retries: 0 });
		await releaseSecond();
	});
});

describe("Windows update helper", () => {
	it("waits for the current PID and includes resource, binary, verification, and rollback steps", () => {
		const script = buildWindowsUpdateScript({
			parentProcessId: 4242,
			operationId: BINARY_UPDATE_OPERATION_ID,
			currentBinary: "/Users/O'Brien/Magenta/magenta.exe",
			stagingDirectory: `/Users/O'Brien/Magenta/.magenta-update-staging-${BINARY_UPDATE_OPERATION_ID}`,
			backupDirectory: `/Users/O'Brien/Magenta/.magenta-update-backup-${BINARY_UPDATE_OPERATION_ID}`,
			resourceNames: ["theme", "tools", "package.json", "photon_rs_bg.wasm", "_magenta"],
			targetVersion: "0.0.12",
			scriptPath: `/Users/O'Brien/Magenta/.magenta-update-${BINARY_UPDATE_OPERATION_ID}.ps1`,
			errorLogPath: "/Users/O'Brien/Magenta/.update-error.log",
		});

		expect(script).toContain("Get-Process -Id $parentProcessId");
		expect(script).toContain("$parentProcessId = 4242");
		expect(script).not.toContain("tasklist");
		expect(script).toContain(".magenta-install-update.lock");
		expect(script).toContain("New-Item -ItemType Directory -Path $lockDirectory");
		expect(script).toContain("Timed out waiting for another Magenta install/update transaction");
		expect(script).toContain("Try-Remove-MagentaStaleLock");
		expect(script).toContain("Update-MagentaLockHeartbeat");
		expect(script).toContain("Start-MagentaBackgroundHeartbeat");
		expect(script).toContain("Register-ObjectEvent");
		expect(script).toContain("$script:lockHeartbeatTimer.Interval = 10000");
		expect(script).toContain("Release-MagentaInstallLock");
		expect(script).toContain("[IO.Directory]::Delete($lockDirectory, $false)");
		expect(script).not.toContain("Remove-Item -LiteralPath $lockDirectory -Recurse");
		expect(script).toContain("Get-MagentaOwnerSid");
		expect(script).toContain("WindowsIdentity]::GetCurrent().User.Value");
		expect(script).toContain("Read-MagentaValidatedJournal");
		expect(script).toContain("Installed resources no longer match the journal snapshot");
		expect(script).toContain("[IO.FileOptions]::WriteThrough");
		expect(script).toContain("$journalStream.Flush($true)");
		expect(script).not.toContain("[IO.File]::WriteAllText($journalTempPath");
		expect(script).toContain("Remove-MagentaSafeTree $backupDirectory");
		expect(script).toContain("Refusing to remove a reparse point from the update transaction");
		expect(script).not.toContain("Remove-Item -LiteralPath $backupDirectory -Recurse");
		expect(script).not.toContain("Remove-Item -LiteralPath $stagingDirectory -Recurse");
		expect(script).toContain("$requiredResourceDirectories");
		expect(script).toContain("    '_magenta'");
		expect(script).toContain(
			"runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
		);
		expect(script).toContain("Test-MagentaResourceDirectory");
		expect(script).toContain("Test-MagentaResourceFile");
		expect(script).toContain("ConvertFrom-Json");
		expect(script).toContain("if ($currentResourcesValid)");
		expect(script).toContain("refusing to overwrite it with older $targetVersion");
		expect(script).toContain("Move-Item -LiteralPath $stagedPath -Destination $installedPath");
		expect(script).toContain("[IO.File]::Replace($stagedBinary, $currentBinary, $backupBinary, $true)");
		expect(script).toContain('Write-MagentaUpdateJournalPhase "committed"');
		expect(script).toContain("$env:PI_PACKAGE_DIR = $installDirectory");
		expect(script).toContain("for ($index = $movedNewResources.Count - 1; $index -ge 0; $index--)");
		expect(script).toContain("for ($index = $movedOldResources.Count - 1; $index -ge 0; $index--)");
		expect(script).toContain("O''Brien");
	});

	it("quotes PowerShell single-quoted path literals", () => {
		expect(quotePowerShellLiteral("C:\\Users\\O'Brien\\Magenta")).toBe("'C:\\Users\\O''Brien\\Magenta'");
	});

	it("abandons lock ownership before a heartbeat failure can enter rollback", () => {
		const script = buildWindowsUpdateScript({
			parentProcessId: 4242,
			operationId: BINARY_UPDATE_OPERATION_ID,
			currentBinary: "/Users/owner/Magenta/magenta.exe",
			stagingDirectory: `/Users/owner/Magenta/.magenta-update-staging-${BINARY_UPDATE_OPERATION_ID}`,
			backupDirectory: `/Users/owner/Magenta/.magenta-update-backup-${BINARY_UPDATE_OPERATION_ID}`,
			resourceNames: ["theme"],
			targetVersion: "0.0.12",
			scriptPath: `/Users/owner/Magenta/.magenta-update-${BINARY_UPDATE_OPERATION_ID}.ps1`,
			errorLogPath: "/Users/owner/Magenta/magenta.exe.update-error.log",
		});
		const heartbeatBody = script.slice(
			script.indexOf("function Update-MagentaLockHeartbeat"),
			script.indexOf("function Start-MagentaBackgroundHeartbeat"),
		);
		expect(heartbeatBody).toMatch(
			/} catch \{\s*\$heartbeatError = \$_\s*\$script:lockAcquired = \$false\s*Stop-MagentaBackgroundHeartbeat\s*throw \$heartbeatError/s,
		);
		const rollbackBody = script.slice(script.indexOf("$rollbackIntentPersisted = $false"));
		expect(rollbackBody).toMatch(/if \(\$lockAcquired\) \{[\s\S]*Write-MagentaUpdateJournalPhase "rolling_back"/);
		expect(rollbackBody).toMatch(/if \(\$rollbackIntentPersisted\) \{[\s\S]*\[IO\.File\]::Replace\(\$backupBinary/);
	});

	it("validates every Windows journal field type before coercion or mutation", () => {
		const script = buildWindowsUpdateScript({
			parentProcessId: 4242,
			operationId: BINARY_UPDATE_OPERATION_ID,
			currentBinary: "/Users/owner/Magenta/magenta.exe",
			stagingDirectory: `/Users/owner/Magenta/.magenta-update-staging-${BINARY_UPDATE_OPERATION_ID}`,
			backupDirectory: `/Users/owner/Magenta/.magenta-update-backup-${BINARY_UPDATE_OPERATION_ID}`,
			resourceNames: ["theme"],
			targetVersion: "0.0.12",
			scriptPath: `/Users/owner/Magenta/.magenta-update-${BINARY_UPDATE_OPERATION_ID}.ps1`,
			errorLogPath: "/Users/owner/Magenta/magenta.exe.update-error.log",
		});
		expect(script).toContain("$journal.version -is [System.Int32]");
		expect(script).toContain("$journal.version -is [System.Int64]");
		expect(script).toContain("$journal.$stringProperty -is [string]");
		expect(script).toContain("$journal.resourceNames -is [System.Array]");
		expect(script).toContain("$journal.originalResourceNames -is [System.Array]");
		expect(script).toContain("$resourceValue -is [string]");
		expect(script).toContain("Compare-Object $expectedProperties $actualProperties -CaseSensitive");
		expect(script.indexOf('Read-MagentaValidatedJournal $journalPath "prepared" $true')).toBeLessThan(
			script.indexOf("Move-Item -LiteralPath $installedPath -Destination $backupPath"),
		);
	});

	it("reports and clears a failed asynchronous helper on the next launch", async () => {
		const root = await makeTemporaryDirectory();
		const currentBinary = join(root, "magenta.exe");
		const errorLog = `${currentBinary}.update-error.log`;
		await writeFile(errorLog, "\uFEFFUpdate failed: access denied\r\n", "utf8");

		await expect(consumePreviousWindowsUpdateError({ currentBinary, force: true })).resolves.toBe(
			"Update failed: access denied",
		);
		expect(existsSync(errorLog)).toBe(false);
		await expect(consumePreviousWindowsUpdateError({ currentBinary, force: true })).resolves.toBeUndefined();
	});
});

describe("checkForUpdate error surfacing", () => {
	it("fetches integrity-bearing release metadata directly even when a mirror is configured", async () => {
		vi.stubEnv("MAGENTA_GITHUB_MIRROR", "https://untrusted-mirror.example");
		_clearMirrorCache();
		const sha256 = "a".repeat(64);
		const asset = (name: string) => ({
			name,
			browser_download_url: `https://github.com/Minions-Land/Magenta-CLI/releases/download/v999.0.0/${name}`,
			digest: `sha256:${sha256}`,
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						tag_name: "v999.0.0",
						name: "test",
						body: "",
						published_at: "2026-07-14T00:00:00Z",
						assets: [
							asset("magenta-macos-arm64"),
							asset("magenta-macos-x64"),
							asset("magenta-linux-x64"),
							asset("magenta-windows-x64.exe"),
							asset(RELEASE_RESOURCES_ASSET_NAME),
							asset(RELEASE_CHECKSUMS_ASSET_NAME),
						],
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkForUpdate({ force: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest",
			expect.anything(),
		);
		expect(result.releaseAssets?.checksums.sha256).toBe(sha256);
	});

	it("surfaces a rate-limit reason instead of swallowing the API error", async () => {
		const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
		const fetchMock = vi.fn(async () => {
			return new Response("rate limited", {
				status: 403,
				headers: {
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": String(resetEpoch),
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkForUpdate({ force: true });

		expect(result.updateAvailable).toBe(false);
		expect(result.error).toContain("Could not fetch latest release");
		expect(result.error).toContain("Rate limit exceeded");
		expect(result.error).toContain("MAGENTA_GITHUB_TOKEN");
	});

	it("surfaces a generic API error with status detail", async () => {
		const fetchMock = vi.fn(async () => new Response("boom", { status: 500, statusText: "Server Error" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkForUpdate({ force: true });

		expect(result.updateAvailable).toBe(false);
		expect(result.error).toContain("Could not fetch latest release");
		expect(result.error).toContain("500");
	});

	it("surfaces a network failure reason", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("getaddrinfo ENOTFOUND api.github.com");
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkForUpdate({ force: true });

		expect(result.updateAvailable).toBe(false);
		expect(result.error).toContain("Could not fetch latest release");
		expect(result.error).toContain("ENOTFOUND");
	});

	it("reports the 404/empty case distinctly", async () => {
		const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkForUpdate({ force: true });

		expect(result.updateAvailable).toBe(false);
		expect(result.error).toContain("404 or empty response");
	});
});

describe("downloadReleaseAsset resilience", () => {
	const makeAsset = (name: string) => ({
		name,
		downloadUrl: `https://github.com/Minions-Land/Magenta-CLI/releases/download/v999.0.0/${name}`,
		sha256: "b".repeat(64),
	});

	it("classifies Bun transport failures as retryable without retrying permanent HTTP errors", () => {
		expect(isRetryableDownloadError(new Error("The socket connection was closed unexpectedly."))).toBe(true);
		expect(isRetryableDownloadError(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(
			true,
		);
		expect(isRetryableDownloadError(new Error("fetch failed"))).toBe(true);
		expect(isRetryableDownloadError(new Error("Download failed for asset: 404 Not Found"))).toBe(false);
	});

	it("retries a transient abort and then succeeds", async () => {
		const directory = await makeTemporaryDirectory();
		const destination = join(directory, "asset.bin");
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				const error = new Error("The operation was aborted.");
				error.name = "AbortError";
				throw error;
			}
			return new Response("payload-bytes", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await downloadReleaseAsset(makeAsset("magenta-macos-arm64"), destination, { retryDelayMs: 0 });

		expect(calls).toBe(2);
		expect(await readFile(destination, "utf8")).toBe("payload-bytes");
	});

	it("surfaces a clear stall message after exhausting retries", async () => {
		const directory = await makeTemporaryDirectory();
		const destination = join(directory, "asset.bin");
		const fetchMock = vi.fn(async () => {
			const error = new Error("The operation was aborted.");
			error.name = "AbortError";
			throw error;
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			downloadReleaseAsset(makeAsset("magenta-linux-x64"), destination, { retryDelayMs: 0 }),
		).rejects.toThrow(/stalled/);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry a permanent HTTP failure", async () => {
		const directory = await makeTemporaryDirectory();
		const destination = join(directory, "asset.bin");
		const fetchMock = vi.fn(async () => new Response("gone", { status: 404, statusText: "Not Found" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(downloadReleaseAsset(makeAsset("magenta-linux-x64"), destination)).rejects.toThrow(/404/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
