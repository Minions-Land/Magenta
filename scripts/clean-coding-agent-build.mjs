#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKAGE_ROOT = join(REPO_ROOT, "pi/coding-agent");
const BUN_SCRATCH_PATTERN = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*\.bun-build$/u;

function inspectBunScratchEntries(packageRoot) {
	const root = resolve(packageRoot);
	const scratchEntries = readdirSync(root, { withFileTypes: true }).filter((entry) =>
		BUN_SCRATCH_PATTERN.test(entry.name),
	);
	for (const entry of scratchEntries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) {
			throw new Error(`Refusing to remove non-file Bun scratch path: ${join(root, entry.name)}`);
		}
	}
	return { root, scratchEntries };
}

export function cleanCodingAgentBunScratch(packageRoot = DEFAULT_PACKAGE_ROOT) {
	const { root, scratchEntries } = inspectBunScratchEntries(packageRoot);
	for (const entry of scratchEntries) rmSync(join(root, entry.name));
	return scratchEntries.map((entry) => entry.name).sort();
}

export function cleanCodingAgentBuild(packageRoot = DEFAULT_PACKAGE_ROOT) {
	const { root } = inspectBunScratchEntries(packageRoot);
	const removedScratch = cleanCodingAgentBunScratch(root);

	const distPath = join(root, "dist");
	if (existsSync(distPath)) {
		const stats = lstatSync(distPath);
		if (stats.isDirectory() && !stats.isSymbolicLink()) rmSync(distPath, { recursive: true });
		else if (stats.isFile() || stats.isSymbolicLink()) rmSync(distPath);
		else throw new Error(`Refusing to remove unsupported coding-agent dist path: ${distPath}`);
	}
	return removedScratch;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("clean-coding-agent-build.mjs does not accept arguments");
	const removed = cleanCodingAgentBuild();
	process.stdout.write(`Cleaned coding-agent build output (${removed.length} Bun scratch files).\n`);
}
