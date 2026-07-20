import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "copy-clipboard-runtime-assets.mjs");
const temporaryDirectories = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-clipboard-assets-"));
	temporaryDirectories.push(root);
	return {
		sourceRoot: join(root, "source", "@mariozechner"),
		targetRoot: join(root, "target", "runtime", "node_modules", "@mariozechner"),
	};
}

function addPackage(sourceRoot, name) {
	const packageRoot = join(sourceRoot, name);
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: `@mariozechner/${name}` })}\n`);
}

test.afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

test("copies installed clipboard packages under the packaged runtime root", () => {
	const paths = fixture();
	addPackage(paths.sourceRoot, "clipboard");
	addPackage(paths.sourceRoot, "clipboard-darwin-universal");

	const result = spawnSync(
		process.execPath,
		[scriptPath, "--source-root", paths.sourceRoot, "--target-root", paths.targetRoot],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(paths.targetRoot, "clipboard", "package.json")), true);
	assert.equal(existsSync(join(paths.targetRoot, "clipboard-darwin-universal", "package.json")), true);
});

test("fails a universal release build when any released target binding is missing", () => {
	const paths = fixture();
	addPackage(paths.sourceRoot, "clipboard");
	addPackage(paths.sourceRoot, "clipboard-darwin-universal");

	const result = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--source-root",
			paths.sourceRoot,
			"--target-root",
			paths.targetRoot,
			"--require-release-targets",
		],
		{ encoding: "utf8" },
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /clipboard-linux-x64-gnu/);
	assert.match(result.stderr, /clipboard-win32-x64-msvc/);
});
