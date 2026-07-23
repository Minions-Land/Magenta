import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUnixInstallerArguments, parseUnixUninstallerArguments } from "../src/cli/unix-installer-command.ts";
import { getBinaryAssetName, lockInstallMutation } from "../src/utils/github-release-update.ts";
import {
	RELEASE_RESOURCE_MARKER_NAME,
	RELEASE_RESOURCES_ASSET_NAME,
	RELEASE_UPDATE_JOURNAL_NAME,
	REQUIRED_RESOURCE_PATHS,
	RESOURCE_DIRECTORY_NAMES,
	RESOURCE_FILE_NAMES,
	readInstalledReleaseOwnership,
	recoverInterruptedReleaseUpdateTransaction,
	writeInstalledReleaseOwnership,
} from "../src/utils/github-release-update-support.ts";
import {
	type InstallLocalUnixReleaseOptions,
	installLocalUnixRelease,
	uninstallLocalUnixRelease,
} from "../src/utils/unix-installer.ts";

const VERSION = "0.0.12";
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "magenta-unix-installer-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeText(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function createCandidate(root: string, version = VERSION): Promise<string> {
	const candidate = join(root, "candidate-magenta");
	await writeFile(
		candidate,
		`#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
if [ "\${1:-}" = "--help" ]; then
	printf 'Magenta test CLI\nUsage: magenta [options]\n'
  if [ "\${2:-}" = "--offline" ]; then
    helper="\${PI_PACKAGE_DIR}/_magenta/process-tools/target/release/magenta-process-tools"
    mkdir -p "$(dirname "$helper")"
    printf '#!/bin/sh\\nexit 0\\n' > "$helper"
    chmod 0755 "$helper"
  fi
  exit 0
fi
exit 2
`,
		"utf8",
	);
	await chmod(candidate, 0o755);
	return candidate;
}

async function createResourceArchive(root: string, version = VERSION): Promise<string> {
	const resourceRoot = join(root, "resources");
	const archive = join(root, RELEASE_RESOURCES_ASSET_NAME);
	for (const directoryName of RESOURCE_DIRECTORY_NAMES)
		await mkdir(join(resourceRoot, directoryName), { recursive: true });
	for (const fileName of RESOURCE_FILE_NAMES) {
		await writeText(
			join(resourceRoot, fileName),
			fileName === "package.json"
				? `${JSON.stringify({ piConfig: { name: "Magenta", binaryName: "magenta", configDir: ".magenta" } })}\n`
				: `${fileName}\n`,
		);
	}
	await writeText(join(resourceRoot, RELEASE_RESOURCE_MARKER_NAME), `${JSON.stringify({ version })}\n`);
	for (const requiredPath of REQUIRED_RESOURCE_PATHS) {
		await writeText(join(resourceRoot, ...requiredPath.split("/")), `${requiredPath}\n`);
	}
	await writeFile(join(resourceRoot, "photon_rs_bg.wasm"), new Uint8Array([0, 97, 115, 109]));
	const result = spawnSync(
		"tar",
		[
			"-czf",
			archive,
			"-C",
			resourceRoot,
			...RESOURCE_DIRECTORY_NAMES,
			...RESOURCE_FILE_NAMES,
			RELEASE_RESOURCE_MARKER_NAME,
			"photon_rs_bg.wasm",
		],
		{ encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
	);
	expect(result.status, result.stderr).toBe(0);
	return archive;
}

async function sha256(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function createFixture() {
	const root = await makeTemporaryDirectory();
	const installDirectory = join(root, "install");
	await mkdir(installDirectory);
	const canonicalInstallDirectory = await realpath(installDirectory);
	const candidateBinary = await createCandidate(root);
	const resourceArchive = await createResourceArchive(root);
	const checksumsFile = join(root, "SHA256SUMS");
	const binaryAssetName = getBinaryAssetName();
	await writeFile(
		checksumsFile,
		`${await sha256(candidateBinary)}  ${binaryAssetName}\n${await sha256(resourceArchive)}  ${RELEASE_RESOURCES_ASSET_NAME}\n`,
		"utf8",
	);
	return {
		root,
		installDirectory: canonicalInstallDirectory,
		candidateBinary,
		resourceArchive,
		checksumsFile,
		binaryAssetName,
	};
}

function installOptions(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	operationId = "a".repeat(32),
): InstallLocalUnixReleaseOptions {
	return {
		...fixture,
		expectedVersion: VERSION,
		launchedExecutable: fixture.candidateBinary,
		operationId,
		verifyMacCandidate: vi.fn(),
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Unix release installer helper", () => {
	it("installs a verified fresh release and preserves unrelated files", async () => {
		const fixture = await createFixture();
		await writeText(join(fixture.installDirectory, "other-program"), "keep me");
		const options = installOptions(fixture);

		await expect(installLocalUnixRelease(options)).resolves.toMatchObject({ version: VERSION });

		expect(await readFile(join(fixture.installDirectory, "other-program"), "utf8")).toBe("keep me");
		expect(
			spawnSync(join(fixture.installDirectory, "magenta"), ["--version"], { encoding: "utf8" }).stdout.trim(),
		).toBe(VERSION);
		expect(existsSync(join(fixture.installDirectory, RELEASE_UPDATE_JOURNAL_NAME))).toBe(false);
		const ownership = await readInstalledReleaseOwnership(fixture.installDirectory);
		expect(ownership.resourceNames).toContain("_magenta");
		if (process.platform === "darwin") {
			expect(options.verifyMacCandidate).toHaveBeenCalledWith(await realpath(fixture.candidateBinary));
		}
	});

	it("removes retired marker-owned payloads on upgrade and uninstall", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await writeText(join(fixture.installDirectory, "retired.wasm"), "retired payload");
		const previousOwnership = await readInstalledReleaseOwnership(fixture.installDirectory);
		await writeInstalledReleaseOwnership(fixture.installDirectory, VERSION, [
			...(previousOwnership.resourceNames ?? []),
			"retired.wasm",
		]);

		await expect(installLocalUnixRelease(installOptions(fixture, "b".repeat(32)))).resolves.toMatchObject({
			version: VERSION,
		});
		expect(existsSync(join(fixture.installDirectory, "retired.wasm"))).toBe(false);

		await expect(uninstallLocalUnixRelease({ installDirectory: fixture.installDirectory })).resolves.toEqual({
			removed: true,
			warnings: [],
		});
		expect(existsSync(join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME))).toBe(false);
	});

	it("restores a retired payload after an interrupted local upgrade", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await writeText(join(fixture.installDirectory, "retired.wasm"), "retired payload");
		const previousOwnership = await readInstalledReleaseOwnership(fixture.installDirectory);
		await writeInstalledReleaseOwnership(fixture.installDirectory, VERSION, [
			...(previousOwnership.resourceNames ?? []),
			"retired.wasm",
		]);
		const options = installOptions(fixture, "c".repeat(32));
		options.testFaultInjector = (point) => {
			if (point === "resource-backup:retired.wasm") throw new Error("simulated upgrade stop");
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/simulated upgrade stop/i);
		const releaseLock = await lockInstallMutation(fixture.installDirectory, { retries: 0 });
		try {
			await expect(recoverInterruptedReleaseUpdateTransaction(fixture.installDirectory)).resolves.toBe(true);
		} finally {
			await releaseLock();
		}
		expect(await readFile(join(fixture.installDirectory, "retired.wasm"), "utf8")).toBe("retired payload");
		expect((await readInstalledReleaseOwnership(fixture.installDirectory)).resourceNames).toContain("retired.wasm");
	});

	it("transactionally repairs damaged resources without replacing unrelated files", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await rm(join(fixture.installDirectory, "theme", "dark.json"));
		await writeText(join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME), "damaged marker\n");
		await writeText(join(fixture.installDirectory, "operator-note"), "preserve me");

		await expect(installLocalUnixRelease(installOptions(fixture, "b".repeat(32)))).resolves.toMatchObject({
			version: VERSION,
		});

		expect(await readFile(join(fixture.installDirectory, "theme", "dark.json"), "utf8")).toContain("theme/dark.json");
		expect(await readFile(join(fixture.installDirectory, "operator-note"), "utf8")).toBe("preserve me");
	});

	it("reinstalls proven resources left behind without a binary", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await writeText(
			join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME),
			`${JSON.stringify({ version: VERSION })}\n`,
		);
		await rm(join(fixture.installDirectory, "magenta"));
		await rm(join(fixture.installDirectory, "runtime"), { recursive: true });

		await expect(installLocalUnixRelease(installOptions(fixture, "b".repeat(32)))).resolves.toMatchObject({
			version: VERSION,
		});
		expect(existsSync(join(fixture.installDirectory, "runtime"))).toBe(true);
		expect(existsSync(join(fixture.installDirectory, "magenta"))).toBe(true);
	});

	it("repairs a binary-only legacy install but rejects unproven resource collisions", async () => {
		const binaryOnly = await createFixture();
		await copyFile(binaryOnly.candidateBinary, join(binaryOnly.installDirectory, "magenta"));
		await chmod(join(binaryOnly.installDirectory, "magenta"), 0o755);
		await expect(installLocalUnixRelease(installOptions(binaryOnly))).resolves.toMatchObject({ version: VERSION });

		const foreignBinary = await createFixture();
		await writeText(
			join(foreignBinary.installDirectory, "magenta"),
			`#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo '${VERSION}'; exit 0; fi
if [ "\${1:-}" = "--help" ]; then echo 'unrelated utility usage'; exit 0; fi
exit 2
`,
		);
		await chmod(join(foreignBinary.installDirectory, "magenta"), 0o755);
		await expect(installLocalUnixRelease(installOptions(foreignBinary))).rejects.toThrow(/CLI identity/i);
		expect(await readFile(join(foreignBinary.installDirectory, "magenta"), "utf8")).toContain("unrelated utility");

		const unproven = await createFixture();
		await writeText(join(unproven.installDirectory, "README.md"), "foreign readme");
		await expect(installLocalUnixRelease(installOptions(unproven))).rejects.toThrow(
			/cannot be proven.*Magenta-owned/i,
		);
		expect(await readFile(join(unproven.installDirectory, "README.md"), "utf8")).toBe("foreign readme");
		expect(existsSync(join(unproven.installDirectory, "magenta"))).toBe(false);
	});

	it("fails closed when a damaged install loses both marker and package identity", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await rm(join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME));
		await rm(join(fixture.installDirectory, "package.json"));

		await expect(installLocalUnixRelease(installOptions(fixture, "b".repeat(32)))).rejects.toThrow(
			/no valid package identity/i,
		);
		expect(existsSync(join(fixture.installDirectory, "magenta"))).toBe(true);
	});

	it("rejects a symbolic-link managed resource before any repair mutation", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		const external = join(fixture.root, "external-docs");
		await writeText(join(external, "sentinel"), "outside");
		await rm(join(fixture.installDirectory, "docs"), { recursive: true });
		await symlink(external, join(fixture.installDirectory, "docs"));

		await expect(installLocalUnixRelease(installOptions(fixture, "b".repeat(32)))).rejects.toThrow(/symbolic-link/i);
		expect(await readFile(join(external, "sentinel"), "utf8")).toBe("outside");
		expect((await lstat(join(fixture.installDirectory, "docs"))).isSymbolicLink()).toBe(true);
	});

	it("requires package identity before claiming legacy binary-less resources", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await writeText(
			join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME),
			`${JSON.stringify({ version: VERSION })}\n`,
		);
		await writeText(
			join(fixture.installDirectory, "package.json"),
			`${JSON.stringify({ name: "foreign-package" })}\n`,
		);
		await rm(join(fixture.installDirectory, "magenta"));

		await expect(installLocalUnixRelease(installOptions(fixture, "b".repeat(32)))).rejects.toThrow(
			/no valid package identity/i,
		);
		expect(await readFile(join(fixture.installDirectory, "package.json"), "utf8")).toContain("foreign-package");
	});

	it("rejects foreign regular-file and symbolic-link PATH collisions before installing a private root", async () => {
		const regular = await createFixture();
		const regularRoot = join(regular.root, "private", "magenta");
		await mkdir(regularRoot, { recursive: true });
		await writeText(join(regular.installDirectory, "magenta"), "#!/bin/sh\nexit 1\n");
		await chmod(join(regular.installDirectory, "magenta"), 0o755);
		await expect(
			installLocalUnixRelease({
				...installOptions(regular),
				installDirectory: await realpath(regularRoot),
				entrypointPath: join(regular.installDirectory, "magenta"),
				legacyInstallDirectory: regular.installDirectory,
			}),
		).rejects.toThrow(/version verification|CLI identity/i);
		expect(existsSync(join(regularRoot, "magenta"))).toBe(false);

		const linked = await createFixture();
		const linkedRoot = join(linked.root, "private", "magenta");
		await mkdir(linkedRoot, { recursive: true });
		await symlink(linked.candidateBinary, join(linked.installDirectory, "magenta"));
		await expect(
			installLocalUnixRelease({
				...installOptions(linked),
				installDirectory: await realpath(linkedRoot),
				entrypointPath: join(linked.installDirectory, "magenta"),
				legacyInstallDirectory: linked.installDirectory,
			}),
		).rejects.toThrow(/symbolic link is not owned/i);
		expect(existsSync(join(linkedRoot, "magenta"))).toBe(false);
	});

	it("migrates a proven flat install to a private root and atomic PATH symlink", async () => {
		const fixture = await createFixture();
		await writeText(join(fixture.installDirectory, "other-program"), "preserve me");
		await installLocalUnixRelease(installOptions(fixture));
		await writeText(
			join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME),
			`${JSON.stringify({ version: VERSION })}\n`,
		);
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });

		await expect(
			installLocalUnixRelease({
				...installOptions(fixture, "b".repeat(32)),
				installDirectory: await realpath(privateRoot),
				entrypointPath: join(fixture.installDirectory, "magenta"),
				legacyInstallDirectory: fixture.installDirectory,
			}),
		).resolves.toMatchObject({ version: VERSION, warnings: [] });

		expect((await lstat(join(fixture.installDirectory, "magenta"))).isSymbolicLink()).toBe(true);
		expect(await realpath(join(fixture.installDirectory, "magenta"))).toBe(
			join(await realpath(privateRoot), "magenta"),
		);
		expect(await readFile(join(fixture.installDirectory, "other-program"), "utf8")).toBe("preserve me");
		expect(existsSync(join(fixture.installDirectory, "runtime"))).toBe(false);
		expect(existsSync(join(privateRoot, "runtime"))).toBe(true);
	});

	it("leaves the old entrypoint intact when interrupted before atomic activation", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const options = {
			...installOptions(fixture, "b".repeat(32)),
			installDirectory: await realpath(privateRoot),
			entrypointPath: join(fixture.installDirectory, "magenta"),
			legacyInstallDirectory: fixture.installDirectory,
		};
		options.testFaultInjector = (point) => {
			if (point === "entrypoint:prepared") throw new Error("simulated entrypoint stop");
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/simulated entrypoint stop/);
		expect((await lstat(join(fixture.installDirectory, "magenta"))).isFile()).toBe(true);
		expect(existsSync(join(fixture.installDirectory, `.magenta-entrypoint-${"b".repeat(32)}`))).toBe(false);
		expect(existsSync(join(privateRoot, ".magenta-unix-layout-journal.json"))).toBe(true);
		await expect(
			installLocalUnixRelease({ ...options, operationId: "c".repeat(32), testFaultInjector: undefined }),
		).resolves.toMatchObject({ warnings: [] });
		expect((await lstat(join(fixture.installDirectory, "magenta"))).isSymbolicLink()).toBe(true);
		expect(existsSync(join(privateRoot, ".magenta-unix-layout-journal.json"))).toBe(false);
		expect(existsSync(join(fixture.installDirectory, `.magenta-entrypoint-backup-${"b".repeat(32)}`))).toBe(false);
	});

	it("finishes durable cleanup when activation completed before acknowledgement", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const entrypointPath = join(fixture.installDirectory, "magenta");
		const operationId = "b".repeat(32);
		const options = {
			...installOptions(fixture, operationId),
			installDirectory: await realpath(privateRoot),
			entrypointPath,
			legacyInstallDirectory: fixture.installDirectory,
			testFaultInjector: (point: string) => {
				if (point === "entrypoint:activated") throw new Error("simulated post-activation stop");
			},
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/pending durable recovery/u);
		expect((await lstat(entrypointPath)).isSymbolicLink()).toBe(true);
		expect(await realpath(entrypointPath)).toBe(join(await realpath(privateRoot), "magenta"));
		expect(existsSync(join(privateRoot, ".magenta-unix-layout-journal.json"))).toBe(true);
		expect(existsSync(join(fixture.installDirectory, `.magenta-entrypoint-backup-${operationId}`))).toBe(true);

		await expect(
			installLocalUnixRelease({ ...options, operationId: "c".repeat(32), testFaultInjector: undefined }),
		).resolves.toMatchObject({ warnings: [] });
		expect(existsSync(join(privateRoot, ".magenta-unix-layout-journal.json"))).toBe(false);
		expect(existsSync(join(fixture.installDirectory, `.magenta-entrypoint-backup-${operationId}`))).toBe(false);
	});

	it("refuses to overwrite an entrypoint created after absent-path preflight", async () => {
		const fixture = await createFixture();
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const entrypointPath = join(fixture.installDirectory, "magenta");
		const options = {
			...installOptions(fixture),
			installDirectory: await realpath(privateRoot),
			entrypointPath,
			legacyInstallDirectory: fixture.installDirectory,
			testFaultInjector: (point: string) => {
				if (point === "entrypoint:prepared") writeFileSync(entrypointPath, "foreign executable\n", "utf8");
			},
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/changed after installer preflight/i);
		expect(await readFile(entrypointPath, "utf8")).toBe("foreign executable\n");
	});

	it("refuses to overwrite a legacy entrypoint replaced after preflight", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const entrypointPath = join(fixture.installDirectory, "magenta");
		const options = {
			...installOptions(fixture, "b".repeat(32)),
			installDirectory: await realpath(privateRoot),
			entrypointPath,
			legacyInstallDirectory: fixture.installDirectory,
			testFaultInjector: (point: string) => {
				if (point !== "entrypoint:prepared") return;
				rmSync(entrypointPath);
				writeFileSync(entrypointPath, "replacement executable\n", "utf8");
			},
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/changed after installer preflight/i);
		expect(await readFile(entrypointPath, "utf8")).toBe("replacement executable\n");
	});

	it("rejects an active managed link replaced while the payload is staged", async () => {
		const fixture = await createFixture();
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const entrypointPath = join(fixture.installDirectory, "magenta");
		const baseOptions = {
			...installOptions(fixture),
			installDirectory: await realpath(privateRoot),
			entrypointPath,
			legacyInstallDirectory: fixture.installDirectory,
		};
		await installLocalUnixRelease(baseOptions);
		const foreignTarget = join(fixture.root, "foreign-magenta");
		await writeText(foreignTarget, "foreign executable\n");

		await expect(
			installLocalUnixRelease({
				...baseOptions,
				operationId: "b".repeat(32),
				testFaultInjector: (point) => {
					if (point !== "verification:complete") return;
					rmSync(entrypointPath);
					symlinkSync(foreignTarget, entrypointPath);
				},
			}),
		).rejects.toThrow(/changed after installer preflight/i);
		expect(await realpath(entrypointPath)).toBe(await realpath(foreignTarget));
	});

	it("continues legacy cleanup after an injected post-activation interruption", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const options = {
			...installOptions(fixture, "b".repeat(32)),
			installDirectory: await realpath(privateRoot),
			entrypointPath: join(fixture.installDirectory, "magenta"),
			legacyInstallDirectory: fixture.installDirectory,
			testFaultInjector: (point: string) => {
				if (point.startsWith("legacy-cleanup:")) throw new Error("simulated cleanup stop");
			},
		};
		const first = await installLocalUnixRelease(options);
		expect(first.warnings).toHaveLength(1);
		expect((await lstat(join(fixture.installDirectory, "magenta"))).isSymbolicLink()).toBe(true);

		await expect(
			installLocalUnixRelease({ ...options, operationId: "c".repeat(32), testFaultInjector: undefined }),
		).resolves.toMatchObject({ warnings: [] });
		expect(existsSync(join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME))).toBe(false);
	});

	it("removes every fresh payload entry after an interrupted binary activation", async () => {
		const fixture = await createFixture();
		await writeText(join(fixture.installDirectory, "unrelated"), "keep me");
		const options = installOptions(fixture);
		options.testFaultInjector = (point) => {
			if (point === "binary-install:complete") throw new Error("simulated stop");
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/simulated stop/);
		const releaseLock = await lockInstallMutation(fixture.installDirectory, { retries: 0 });
		try {
			await expect(recoverInterruptedReleaseUpdateTransaction(fixture.installDirectory)).resolves.toBe(true);
		} finally {
			await releaseLock();
		}

		expect(existsSync(join(fixture.installDirectory, "magenta"))).toBe(false);
		for (const resourceName of [...RESOURCE_DIRECTORY_NAMES, ...RESOURCE_FILE_NAMES, RELEASE_RESOURCE_MARKER_NAME]) {
			expect(existsSync(join(fixture.installDirectory, resourceName))).toBe(false);
		}
		expect(await readFile(join(fixture.installDirectory, "unrelated"), "utf8")).toBe("keep me");
	});

	it("does not remove a pre-existing operation directory when mkdir fails", async () => {
		const fixture = await createFixture();
		const operationDirectory = join(fixture.installDirectory, `.magenta-update-staging-${"a".repeat(32)}`);
		await writeText(join(operationDirectory, "sentinel"), "preserve me");

		await expect(installLocalUnixRelease(installOptions(fixture))).rejects.toThrow(/EEXIST|exist/i);
		expect(await readFile(join(operationDirectory, "sentinel"), "utf8")).toBe("preserve me");
	});

	it("rejects assets inside the installation tree before mutation", async () => {
		const fixture = await createFixture();
		const nestedArchive = join(fixture.installDirectory, RELEASE_RESOURCES_ASSET_NAME);
		await copyFile(fixture.resourceArchive, nestedArchive);

		await expect(
			installLocalUnixRelease({ ...installOptions(fixture), resourceArchive: nestedArchive }),
		).rejects.toThrow(/outside the installation directory/i);
		expect(existsSync(join(fixture.installDirectory, "magenta"))).toBe(false);
	});

	it("uses the verified private resource snapshot after the download path changes", async () => {
		const fixture = await createFixture();
		const options = installOptions(fixture);
		options.testFaultInjector = (point) => {
			if (point === "snapshot:complete") writeFileSync(fixture.resourceArchive, "tampered after snapshot");
		};

		await expect(installLocalUnixRelease(options)).resolves.toMatchObject({ version: VERSION, warnings: [] });
		expect(existsSync(join(fixture.installDirectory, "runtime"))).toBe(true);
		expect(existsSync(join(fixture.installDirectory, ".magenta-resources-universal.tar.gz"))).toBe(false);
	});

	it("rejects a resource archive changed before the private snapshot is verified", async () => {
		const fixture = await createFixture();
		const options = installOptions(fixture);
		options.testFaultInjector = (point) => {
			if (point === "snapshot:before-copy") writeFileSync(fixture.resourceArchive, "tampered before snapshot");
		};

		await expect(installLocalUnixRelease(options)).rejects.toThrow(/Checksum verification failed/u);
		expect(existsSync(join(fixture.installDirectory, "magenta"))).toBe(false);
		expect(readdirSync(fixture.installDirectory).some((name) => name.includes("update-staging"))).toBe(false);
	});

	it("rejects symbolic-link assets and a candidate different from the launched executable", async () => {
		const fixture = await createFixture();
		const linkedArchive = join(fixture.root, "linked-resources.tar.gz");
		await symlink(fixture.resourceArchive, linkedArchive);
		await expect(
			installLocalUnixRelease({ ...installOptions(fixture), resourceArchive: linkedArchive }),
		).rejects.toThrow(/symbolic-link/i);

		const otherCandidate = join(fixture.root, "other-candidate");
		await copyFile(fixture.candidateBinary, otherCandidate);
		await chmod(otherCandidate, 0o755);
		await expect(
			installLocalUnixRelease({ ...installOptions(fixture), launchedExecutable: otherCandidate }),
		).rejects.toThrow(/does not match the executable/i);
	});

	it("binds the candidate version to the expected release tag", async () => {
		const fixture = await createFixture();
		await expect(installLocalUnixRelease({ ...installOptions(fixture), expectedVersion: "0.0.13" })).rejects.toThrow(
			/does not match expected/i,
		);
		expect(existsSync(join(fixture.installDirectory, "magenta"))).toBe(false);
	});

	it("safely uninstalls a private layout and leaves user state and unrelated files", async () => {
		const fixture = await createFixture();
		const privateRoot = join(fixture.root, "private", "magenta");
		await mkdir(privateRoot, { recursive: true });
		const entrypointPath = join(fixture.installDirectory, "magenta");
		await installLocalUnixRelease({
			...installOptions(fixture),
			installDirectory: await realpath(privateRoot),
			entrypointPath,
			legacyInstallDirectory: fixture.installDirectory,
		});
		await writeText(join(privateRoot, "operator-note"), "preserve root");
		const userState = join(fixture.root, ".magenta", "messages.db");
		await writeText(userState, "keep state");
		await writeText(join(fixture.installDirectory, "other-program"), "keep executable");

		await expect(
			uninstallLocalUnixRelease({
				installDirectory: await realpath(privateRoot),
				entrypointPath,
				legacyInstallDirectory: fixture.installDirectory,
			}),
		).resolves.toEqual({ removed: true, warnings: [] });
		expect(existsSync(entrypointPath)).toBe(false);
		expect(existsSync(join(privateRoot, "magenta"))).toBe(false);
		expect(await readFile(join(privateRoot, "operator-note"), "utf8")).toBe("preserve root");
		expect(await readFile(userState, "utf8")).toBe("keep state");
		expect(await readFile(join(fixture.installDirectory, "other-program"), "utf8")).toBe("keep executable");

		await expect(
			uninstallLocalUnixRelease({
				installDirectory: await realpath(privateRoot),
				entrypointPath,
				legacyInstallDirectory: fixture.installDirectory,
			}),
		).resolves.toEqual({ removed: false, warnings: [] });
	});

	it("uninstalls proven binary-less remnants and resumes after interruption", async () => {
		const fixture = await createFixture();
		await installLocalUnixRelease(installOptions(fixture));
		await writeText(
			join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME),
			`${JSON.stringify({ version: VERSION })}\n`,
		);
		await rm(join(fixture.installDirectory, "magenta"));

		await expect(
			uninstallLocalUnixRelease({
				installDirectory: fixture.installDirectory,
				testFaultInjector: (point) => {
					if (point.startsWith("uninstall:install:") && !point.endsWith(RELEASE_RESOURCE_MARKER_NAME)) {
						throw new Error("simulated uninstall stop");
					}
				},
			}),
		).rejects.toThrow(/simulated uninstall stop/);
		expect(existsSync(join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME))).toBe(true);
		expect((await readInstalledReleaseOwnership(fixture.installDirectory)).resourceNames).toBeDefined();

		await expect(uninstallLocalUnixRelease({ installDirectory: fixture.installDirectory })).resolves.toEqual({
			removed: true,
			warnings: [],
		});
		expect(existsSync(join(fixture.installDirectory, RELEASE_RESOURCE_MARKER_NAME))).toBe(false);
	});

	it("refuses unproven or symbolic-link uninstall targets before deletion", async () => {
		const unproven = await createFixture();
		await writeText(join(unproven.installDirectory, "README.md"), "foreign");
		await expect(uninstallLocalUnixRelease({ installDirectory: unproven.installDirectory })).rejects.toThrow(
			/cannot be proven.*Magenta-owned/i,
		);
		expect(await readFile(join(unproven.installDirectory, "README.md"), "utf8")).toBe("foreign");

		const linked = await createFixture();
		await installLocalUnixRelease(installOptions(linked));
		const external = join(linked.root, "external-runtime");
		await writeText(join(external, "sentinel"), "outside");
		await rm(join(linked.installDirectory, "runtime"), { recursive: true });
		await symlink(external, join(linked.installDirectory, "runtime"));
		await expect(uninstallLocalUnixRelease({ installDirectory: linked.installDirectory })).rejects.toThrow(
			/symbolic-link/i,
		);
		expect(existsSync(join(linked.installDirectory, "magenta"))).toBe(true);
		expect(await readFile(join(external, "sentinel"), "utf8")).toBe("outside");
	});
});

describe("Unix installer command arguments", () => {
	it("requires each strict helper argument exactly once", () => {
		expect(
			parseUnixInstallerArguments([
				"--install-dir",
				"/install",
				"--resource-archive",
				"/resources",
				"--checksums",
				"/checksums",
				"--binary-asset",
				"magenta-linux-x64",
				"--expected-version",
				VERSION,
			]),
		).toEqual({
			installDirectory: "/install",
			resourceArchive: "/resources",
			checksumsFile: "/checksums",
			binaryAssetName: "magenta-linux-x64",
			expectedVersion: VERSION,
		});
		expect(() => parseUnixInstallerArguments(["--install-dir", "/one", "--install-dir", "/two"])).toThrow(
			/duplicate/i,
		);
		expect(() => parseUnixInstallerArguments(["--unknown", "value"])).toThrow(/unknown/i);
	});

	it("parses optional layout and strict uninstall arguments", () => {
		expect(
			parseUnixUninstallerArguments([
				"--install-dir",
				"/private/magenta",
				"--entrypoint-path",
				"/bin/magenta",
				"--legacy-install-dir",
				"/bin",
			]),
		).toEqual({
			installDirectory: "/private/magenta",
			entrypointPath: "/bin/magenta",
			legacyInstallDirectory: "/bin",
		});
		expect(() => parseUnixUninstallerArguments([])).toThrow(/missing/i);
		expect(() => parseUnixUninstallerArguments(["--install-dir", "/one", "--install-dir", "/two"])).toThrow(
			/duplicate/i,
		);
	});
});
