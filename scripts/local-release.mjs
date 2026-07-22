#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createAndVerifyLocalBinaryArchive } from "./local-release-archive.mjs";
import { handleLocalReleaseOutputFailure, prepareLocalReleaseOutputDirectory } from "./local-release-output.mjs";
import { signLocalMacBinary } from "./local-release-signing.mjs";
import { runReleaseGate } from "./release-gate.mjs";

const packages = [
	{ directory: "pi/ai", name: "@earendil-works/pi-ai" },
	{ directory: "pi/tui", name: "@earendil-works/pi-tui" },
	{ directory: "pi/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "HarnessComponentProtocol", name: "@magenta/harness" },
	{ directory: "pi/coding-agent", name: "@earendil-works/pi-coding-agent" },
];

const binaryResourceEntries = [
	"sandbox",
	"tools",
	"policy",
	"runtime",
	"skills",
	"theme",
	"assets",
	"export-html",
	"docs",
	"examples",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"magenta-release.json",
	"photon_rs_bg.wasm",
];

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated directory outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Replace an existing --out owned by this script
  --skip-check         Do not run npm run check:release after building
  --skip-test          Do not run npm test after building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = {
		force: false,
		outDir: undefined,
		skipBunInstall: false,
		skipCheck: false,
		skipInstall: false,
		skipTest: false,
	};
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--skip-check") {
			options.skipCheck = true;
			continue;
		}
		if (arg === "--skip-test") {
			options.skipTest = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-bun-install") {
			options.skipBunInstall = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) {
				throw new Error("--out requires a directory");
			}
			options.outDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function currentBinaryPlatform() {
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory, binaryName, resourceDirectory) {
	if (!commandExists("bun")) {
		throw new Error("Bun is required for the local binary release build.");
	}
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	run("./scripts/build-binaries.sh", [
		"--skip-install",
		"--skip-deps",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	]);
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	for (const entry of binaryResourceEntries) {
		const source = join(resourceDirectory, entry);
		if (!existsSync(source)) throw new Error(`Built binary resources are missing required entry: ${entry}`);
		cpSync(source, join(targetDirectory, entry), { recursive: true });
	}
	signLocalMacBinary({
		binaryPath: join(targetDirectory, binaryName),
		platform,
		runCommand: (command, args) => run(command, args),
	});
	createAndVerifyLocalBinaryArchive({
		archiveDirectory,
		binaryName,
		platform,
		requiredEntries: binaryResourceEntries,
		targetDirectory,
	});
	rmSync(binaryBuildDirectory, { force: true, recursive: true });
	return platform;
}

function createCliShim(installDirectory, binaryName) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, `${binaryName}.cmd`))) {
			writeFileSync(
				join(installDirectory, `${binaryName}.cmd`),
				`@ECHO off\r\n"%~dp0node_modules\\.bin\\${binaryName}.cmd" %*\r\n`,
			);
			writeFileSync(
				join(installDirectory, `${binaryName}.ps1`),
				`& "$PSScriptRoot/node_modules/.bin/${binaryName}.ps1" @args\n`,
			);
			return;
		}
		writeFileSync(
			join(installDirectory, `${binaryName}.cmd`),
			`@ECHO off\r\n"%~dp0node_modules\\.bin\\${binaryName}.exe" %*\r\n`,
		);
		writeFileSync(
			join(installDirectory, `${binaryName}.ps1`),
			`& "$PSScriptRoot/node_modules/.bin/${binaryName}.exe" @args\n`,
		);
		return;
	}
	symlinkSync(join("node_modules", ".bin", binaryName), join(installDirectory, binaryName));
}

function packPackage(pkg, tarballDirectory) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}

	const output = run("npm", ["pack", "--json", "--pack-destination", tarballDirectory], {
		capture: true,
		cwd: pkg.directory,
	});
	const packed = JSON.parse(output)[0];
	return join(tarballDirectory, packed.filename);
}

const options = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = readPackageJson(repoRoot);
const codingAgentPackageJson = readPackageJson("pi/coding-agent");
const binaryName =
	codingAgentPackageJson.piConfig?.binaryName ?? Object.keys(codingAgentPackageJson.bin ?? {})[0] ?? "pi";

if (rootPackageJson.name !== "pi-monorepo") {
	throw new Error("Run this script from the repository root");
}

let outDir;
try {
	outDir = prepareLocalReleaseOutputDirectory({
		force: options.force,
		outDir: options.outDir,
		repoRoot,
	});
	const tarballDirectory = join(outDir, "tarballs");
	const nodeInstallDirectory = join(outDir, "node");
	const bunInstallDirectory = join(outDir, "bun-install");
	const binaryDirectory = join(outDir, "bun");
	mkdirSync(tarballDirectory, { recursive: true });

	runReleaseGate({
		prepareArtifacts: () => run("npm", ["run", "copy-binary-assets"], { cwd: "pi/coding-agent" }),
		resourceMarker: "pi/coding-agent/dist/magenta-release.json",
		runCommand: (command, args) => run(command, args, { cwd: repoRoot }),
		skipCheck: options.skipCheck,
		skipTest: options.skipTest,
	});

	const tarballs = new Map();
	for (const pkg of packages) {
		const tarball = packPackage(pkg, tarballDirectory);
		tarballs.set(pkg.name, tarball);
	}

	let binaryPlatform;
	if (!options.skipInstall) {
		binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir, binaryName, resolve("pi/coding-agent/dist"));

		mkdirSync(nodeInstallDirectory, { recursive: true });
		const dependencies = Object.fromEntries(
			packages.map((pkg) => [pkg.name, fileSpecifier(nodeInstallDirectory, tarballs.get(pkg.name))]),
		);
		const installPackageJson = `${JSON.stringify({ private: true, dependencies, overrides: dependencies }, undefined, "\t")}\n`;
		writeFileSync(join(nodeInstallDirectory, "package.json"), installPackageJson);

		run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: nodeInstallDirectory });
		createCliShim(nodeInstallDirectory, binaryName);

		if (!options.skipBunInstall) {
			if (!commandExists("bun")) {
				throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
			}
			mkdirSync(bunInstallDirectory, { recursive: true });
			const bunDependencies = Object.fromEntries(
				packages.map((pkg) => [pkg.name, fileSpecifier(bunInstallDirectory, tarballs.get(pkg.name))]),
			);
			writeFileSync(
				join(bunInstallDirectory, "package.json"),
				`${JSON.stringify({ private: true, dependencies: bunDependencies, overrides: bunDependencies }, undefined, "\t")}\n`,
			);
			run("bun", ["install", "--production", "--ignore-scripts"], { cwd: bunInstallDirectory });
			createCliShim(bunInstallDirectory, binaryName);
		}
	}

	console.log("\nLocal release artifacts created:");
	console.log(`  ${outDir}`);
	console.log("\nTarballs:");
	for (const tarball of tarballs.values()) {
		console.log(`  ${tarball}`);
	}

	if (!options.skipInstall) {
		console.log("\nLocal Bun binary release:");
		console.log(`  ${binaryDirectory}`);
		console.log(
			`  ${join(outDir, `${binaryName}-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`,
		);
		console.log("\nRun the local Bun binary release from outside the repository:");
		console.log(
			`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? `${binaryName}.exe` : binaryName)} --help`,
		);

		console.log("\nIsolated npm install:");
		console.log(`  ${nodeInstallDirectory}`);
		console.log("\nRun the locally packed npm CLI from outside the repository:");
		console.log(
			`  ${join(nodeInstallDirectory, process.platform === "win32" ? `${binaryName}.cmd` : binaryName)} --help`,
		);

		if (!options.skipBunInstall) {
			console.log("\nIsolated Bun package install:");
			console.log(`  ${bunInstallDirectory}`);
			console.log("\nRun the locally packed Bun package CLI from outside the repository:");
			console.log(
				`  ${join(bunInstallDirectory, process.platform === "win32" ? `${binaryName}.cmd` : binaryName)} --help`,
			);
		}
	}
} catch (error) {
	if (outDir) {
		try {
			const disposition = handleLocalReleaseOutputFailure({
				explicitOut: options.outDir !== undefined,
				outputDirectory: outDir,
			});
			console.error(`\n${disposition}`);
		} catch (outputError) {
			console.error(`\nLocal release failed; output was not deleted: ${outDir}`);
			throw new AggregateError([error, outputError], "Local release failed and its output could not be finalized");
		}
	}
	throw error;
}
