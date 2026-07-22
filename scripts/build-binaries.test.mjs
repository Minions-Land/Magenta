import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts/build-binaries.sh");
const inertArgs = ["--skip-install", "--skip-deps", "--skip-build"];

function run(...args) {
	return spawnSync("bash", [script, ...inertArgs, ...args], { cwd: repoRoot, encoding: "utf8" });
}

test("refuses an output directory that contains the repository", () => {
	const result = run("--out", repoRoot, "--force");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /contains the repository/u);
});

test("refuses a real ancestor of the repository", () => {
	const result = run("--out", dirname(repoRoot), "--force");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /contains the repository/u);
});

test("resolves a symlinked parent before applying repository boundaries", (context) => {
	if (process.platform === "win32") context.skip("Windows symlink creation requires elevated privileges");
	const sandbox = mkdtempSync(join(tmpdir(), "magenta-binary-output-link-"));
	const repositoryLink = join(sandbox, "repository");
	const protectedFile = join(repoRoot, "scripts", "build-binaries.sh");
	try {
		symlinkSync(repoRoot, repositoryLink, "dir");
		const result = run("--out", join(repositoryLink, "scripts"), "--force");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /inside the repository/u);
		assert.equal(existsSync(protectedFile), true);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

test("does not replace an existing unowned output even with --force", () => {
	const output = mkdtempSync(join(tmpdir(), "magenta-unowned-output-"));
	const keep = join(output, "keep.txt");
	try {
		writeFileSync(keep, "preserve me\n");
		const result = run("--out", output, "--force");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /not owned by this script/u);
		assert.equal(existsSync(keep), true);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

test("requires explicit force before replacing an owned output", () => {
	const output = mkdtempSync(join(tmpdir(), "magenta-owned-output-"));
	const keep = join(output, "keep.txt");
	try {
		writeFileSync(join(output, ".magenta-binary-output"), "magenta-binary-output-v1\n");
		writeFileSync(keep, "preserve me\n");
		const result = run("--out", output);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /use --force only after inspection/u);
		assert.equal(existsSync(keep), true);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

test("the actual default binary output is ignored by Git", () => {
	const ignored = spawnSync(
		"git",
		["check-ignore", "--quiet", "--no-index", "pi/coding-agent/binaries/probe"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	assert.equal(ignored.status, 0, ignored.stderr || ignored.stdout);
});
