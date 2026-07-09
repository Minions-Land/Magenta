import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(harnessRoot, "dist");

const selectedTrees = [
	"harness-component-protocol",
	"hcp-magnet",
	"hcp-contract",
	"catalog",
	"core",
	"modules",
];

const copiedFileNames = new Set([".gitignore", "Cargo.lock", "Cargo.toml", "README.md"]);
const copiedExtensions = new Set([".json", ".md", ".rs", ".toml"]);
const skippedDirs = new Set(["dist", "node_modules", "target"]);

function extensionOf(name) {
	const index = name.lastIndexOf(".");
	return index >= 0 ? name.slice(index) : "";
}

function shouldCopyFile(relativeDir, name) {
	return copiedFileNames.has(name) || copiedExtensions.has(extensionOf(name));
}

async function copyRelativeFile(relativePath) {
	const from = join(harnessRoot, relativePath);
	const to = join(distRoot, relativePath);
	await mkdir(dirname(to), { recursive: true });
	await copyFile(from, to);
}

async function copySelectedTree(relativeDir) {
	const absoluteDir = join(harnessRoot, relativeDir);
	let entries;
	try {
		entries = await readdir(absoluteDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const child = join(relativeDir, entry.name);
		if (entry.isDirectory()) {
			if (skippedDirs.has(entry.name)) continue;
			await copySelectedTree(child);
		} else if (entry.isFile() && shouldCopyFile(relativeDir, entry.name)) {
			await copyRelativeFile(child);
		}
	}
}

for (const tree of selectedTrees) {
	await copySelectedTree(tree);
}
