import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertTarballIntegrity,
	resolveLockedClipboardPackages,
	sha512Integrity,
} from "./stage-release-clipboard.mjs";

test("release clipboard packages are exact and integrity-pinned", () => {
	const packages = resolveLockedClipboardPackages();
	assert.deepEqual(
		packages.map((pkg) => pkg.name),
		[
			"@mariozechner/clipboard",
			"@mariozechner/clipboard-darwin-universal",
			"@mariozechner/clipboard-linux-x64-gnu",
			"@mariozechner/clipboard-win32-x64-msvc",
		],
	);
	assert.equal(new Set(packages.map((pkg) => pkg.version)).size, 1);
	assert.ok(packages.every((pkg) => pkg.integrity.startsWith("sha512-")));
});

test("tarball verification rejects bytes not covered by the lockfile", () => {
	const directory = mkdtempSync(join(tmpdir(), "magenta-clipboard-integrity-"));
	try {
		const tarball = join(directory, "package.tgz");
		writeFileSync(tarball, "verified bytes");
		const expected = sha512Integrity(tarball);
		assert.doesNotThrow(() => assertTarballIntegrity(tarball, expected, "fixture"));
		writeFileSync(tarball, "mutated bytes");
		assert.throws(() => assertTarballIntegrity(tarball, expected, "fixture"), /package-lock\.json/u);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
