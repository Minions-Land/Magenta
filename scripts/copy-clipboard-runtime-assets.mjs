#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const releasePackages = [
	"clipboard",
	"clipboard-darwin-universal",
	"clipboard-linux-x64-gnu",
	"clipboard-win32-x64-msvc",
];

function parseArgs(argv) {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const options = {
		requireReleaseTargets: false,
		sourceRoot: join(repoRoot, "node_modules", "@mariozechner"),
		targetRoot: join(repoRoot, "pi", "coding-agent", "dist", "runtime", "node_modules", "@mariozechner"),
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--require-release-targets") {
			options.requireReleaseTargets = true;
			continue;
		}
		if (arg === "--source-root" || arg === "--target-root") {
			const value = argv[++index];
			if (!value) throw new Error(`${arg} requires a directory`);
			if (arg === "--source-root") options.sourceRoot = resolve(value);
			else options.targetRoot = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function copyClipboardRuntimeAssets(options) {
	const installedPackages = existsSync(options.sourceRoot)
		? readdirSync(options.sourceRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && (entry.name === "clipboard" || entry.name.startsWith("clipboard-")))
				.map((entry) => entry.name)
				.sort()
		: [];

	if (options.requireReleaseTargets) {
		const missing = releasePackages.filter((name) => !installedPackages.includes(name));
		if (missing.length > 0) {
			throw new Error(`Missing clipboard packages required by release targets: ${missing.join(", ")}`);
		}
	}

	if (installedPackages.length === 0) {
		console.log("No @mariozechner/clipboard packages installed; skipping packaged clipboard runtime assets.");
		return;
	}

	mkdirSync(options.targetRoot, { recursive: true });
	for (const packageName of installedPackages) {
		const source = join(options.sourceRoot, packageName);
		const target = join(options.targetRoot, packageName);
		rmSync(target, { force: true, recursive: true });
		cpSync(source, target, { recursive: true });
	}
	console.log(`Copied ${installedPackages.length} clipboard runtime package(s) into ${options.targetRoot}`);
}

try {
	copyClipboardRuntimeAssets(parseArgs(process.argv.slice(2)));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
