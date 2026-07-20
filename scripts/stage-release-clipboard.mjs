#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_PACKAGES = [
	"@mariozechner/clipboard",
	"@mariozechner/clipboard-darwin-universal",
	"@mariozechner/clipboard-linux-x64-gnu",
	"@mariozechner/clipboard-win32-x64-msvc",
];

function npmExecutable() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function parseJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveLockedClipboardPackages(root = REPO_ROOT) {
	const packageJson = parseJson(join(root, "pi/coding-agent/package.json"));
	const lockfile = parseJson(join(root, "package-lock.json"));
	const version = packageJson.optionalDependencies?.["@mariozechner/clipboard"];
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
		throw new Error("The release clipboard dependency must use an exact semantic version.");
	}

	return RELEASE_PACKAGES.map((name) => {
		const entry = lockfile.packages?.[`node_modules/${name}`];
		if (!entry || entry.version !== version || typeof entry.integrity !== "string") {
			throw new Error(`${name}@${version} is not pinned with integrity in package-lock.json.`);
		}
		if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)) {
			throw new Error(`${name}@${version} does not have a SHA-512 lockfile integrity.`);
		}
		return { integrity: entry.integrity, name, version };
	});
}

export function sha512Integrity(path) {
	return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

export function assertTarballIntegrity(path, expectedIntegrity, packageName) {
	const actualIntegrity = sha512Integrity(path);
	if (actualIntegrity !== expectedIntegrity) {
		throw new Error(
			`${packageName} tarball integrity does not match package-lock.json ` +
				`(expected ${expectedIntegrity}, got ${actualIntegrity}).`,
		);
	}
}

function runNpm(args, options = {}) {
	return execFileSync(npmExecutable(), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
}

export function stageReleaseClipboard(outDir, root = REPO_ROOT) {
	const destination = resolve(outDir);
	const temporaryRoot = mkdtempSync(join(tmpdir(), "magenta-release-clipboard-"));
	const tarballDirectory = join(temporaryRoot, "tarballs");
	const installDirectory = join(temporaryRoot, "install");
	mkdirSync(tarballDirectory, { recursive: true });
	mkdirSync(installDirectory, { recursive: true });
	writeFileSync(join(installDirectory, "package.json"), '{"private":true}\n');

	try {
		const lockedPackages = resolveLockedClipboardPackages(root);
		const tarballs = [];
		for (const pkg of lockedPackages) {
			const packed = JSON.parse(
				runNpm(
					[
						"pack",
						`${pkg.name}@${pkg.version}`,
						"--json",
						"--ignore-scripts",
						"--pack-destination",
						tarballDirectory,
					],
					{ capture: true, cwd: root },
				),
			);
			if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
				throw new Error(`npm pack returned an invalid receipt for ${pkg.name}.`);
			}
			const tarball = join(tarballDirectory, basename(packed[0].filename));
			assertTarballIntegrity(tarball, pkg.integrity, pkg.name);
			tarballs.push(tarball);
		}

		runNpm(
			[
				"install",
				"--prefix",
				installDirectory,
				"--omit=dev",
				"--omit=optional",
				"--no-save",
				"--package-lock=false",
				"--force",
				"--ignore-scripts",
				...tarballs,
			],
			{ cwd: root },
		);

		for (const pkg of lockedPackages) {
			const source = join(installDirectory, "node_modules", ...pkg.name.split("/"));
			const installed = parseJson(join(source, "package.json"));
			if (installed.name !== pkg.name || installed.version !== pkg.version) {
				throw new Error(`Staged package identity mismatch for ${pkg.name}.`);
			}
			cpSync(source, join(destination, ...pkg.name.split("/")), { recursive: true });
		}
	} finally {
		rmSync(temporaryRoot, { force: true, recursive: true });
	}
}

function parseArgs(args) {
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/stage-release-clipboard.mjs --out <directory>");
	}
	return args[1];
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		stageReleaseClipboard(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
