import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanCodingAgentBuild, cleanCodingAgentBunScratch } from "./clean-coding-agent-build.mjs";

test("coding-agent clean removes only dist and direct Bun scratch files", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-clean-coding-agent-"));
	try {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "cli.js"), "generated");
		writeFileSync(join(root, ".18c485ff-00000000.bun-build"), "scratch");
		writeFileSync(join(root, "foreground.bun-build"), "scratch");
		writeFileSync(join(root, "operator-note"), "preserve");
		symlinkSync(join(root, "operator-note"), join(root, ".linked.bun-build"));

		assert.deepEqual(cleanCodingAgentBuild(root), [
			".18c485ff-00000000.bun-build",
			".linked.bun-build",
			"foreground.bun-build",
		]);
		assert.equal(existsSync(join(root, "dist")), false);
		assert.equal(existsSync(join(root, ".18c485ff-00000000.bun-build")), false);
		assert.equal(existsSync(join(root, ".linked.bun-build")), false);
		assert.equal(existsSync(join(root, "foreground.bun-build")), false);
		assert.equal(existsSync(join(root, "operator-note")), true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("standalone Bun scratch cleanup leaves compiled dist intact", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-clean-coding-agent-"));
	try {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "magenta"), "compiled output");
		writeFileSync(join(root, ".compile.bun-build"), "scratch");

		assert.deepEqual(cleanCodingAgentBunScratch(root), [".compile.bun-build"]);
		assert.equal(existsSync(join(root, ".compile.bun-build")), false);
		assert.equal(existsSync(join(root, "dist", "magenta")), true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("coding-agent clean fails closed on a scratch-shaped directory before deleting dist", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-clean-coding-agent-"));
	try {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "cli.js"), "preserve until preflight passes");
		mkdirSync(join(root, ".unexpected.bun-build"));

		assert.throws(() => cleanCodingAgentBuild(root), /non-file Bun scratch path/u);
		assert.equal(existsSync(join(root, "dist", "cli.js")), true);
		assert.equal(existsSync(join(root, ".unexpected.bun-build")), true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
