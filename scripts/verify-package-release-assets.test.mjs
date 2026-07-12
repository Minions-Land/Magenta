import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	HcpClientassertreleaseidentity,
	HcpClientpackageplatforms,
	HcpClientvalidatearchiveentrypath,
	HcpClientverifypackagereleaseassets,
} from "./verify-package-release-assets.mjs";

function HcpClientbuildreleasefixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-package-release-verifier-"));
	const packageRoot = join(root, "ClaudeScience");
	const assetsDir = join(root, "assets");
	mkdirSync(packageRoot);
	mkdirSync(assetsDir);
	writeFileSync(
		join(packageRoot, "package.toml"),
		[
			'schema_version = "magenta.package.v2"',
			'id = "ClaudeScience"',
			'name = "ClaudeScience"',
			'version = "0.1.0"',
			'source = "ClaudeScience"',
			"",
		].join("\n"),
	);
	writeFileSync(join(packageRoot, "README.md"), "fixture\n");
	for (const platform of HcpClientpackageplatforms) {
		const archiveName = `ClaudeScience-v0.1.0-${platform}.tar.gz`;
		const archivePath = join(assetsDir, archiveName);
		const tar = spawnSync("tar", ["czf", archivePath, "-C", root, "ClaudeScience"], { encoding: "utf8" });
		assert.equal(tar.status, 0, tar.stderr);
		const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
		writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`);
	}
	return { root, packageRoot, assetsDir };
}

test("verifies an exact four-platform release", () => {
	const fixture = HcpClientbuildreleasefixture();
	try {
		const result = HcpClientverifypackagereleaseassets({
			packageId: "ClaudeScience",
			version: "0.1.0",
			assetsDir: fixture.assetsDir,
		});
		assert.equal(Object.keys(result.archiveHashes).length, 4);
		assert.match(result.manifestHash, /^[a-f0-9]{64}$/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("rejects CRLF checksum files", () => {
	const fixture = HcpClientbuildreleasefixture();
	try {
		const checksum = join(fixture.assetsDir, "ClaudeScience-v0.1.0-windows-x64.tar.gz.sha256");
		writeFileSync(checksum, readFileSync(checksum, "utf8").replace(/\n/g, "\r\n"));
		assert.throws(
			() =>
				HcpClientverifypackagereleaseassets({
					packageId: "ClaudeScience",
					version: "0.1.0",
					assetsDir: fixture.assetsDir,
				}),
			/Checksum must use LF/,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("rejects symlink entries before reading the manifest", () => {
	const fixture = HcpClientbuildreleasefixture();
	try {
		const link = join(fixture.packageRoot, "unsafe-link");
		symlinkSync("package.toml", link);
		const platform = HcpClientpackageplatforms[0];
		const archiveName = `ClaudeScience-v0.1.0-${platform}.tar.gz`;
		const archivePath = join(fixture.assetsDir, archiveName);
		const tar = spawnSync("tar", ["czf", archivePath, "-C", fixture.root, "ClaudeScience"], { encoding: "utf8" });
		assert.equal(tar.status, 0, tar.stderr);
		const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
		writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`);
		assert.throws(
			() =>
				HcpClientverifypackagereleaseassets({
					packageId: "ClaudeScience",
					version: "0.1.0",
					assetsDir: fixture.assetsDir,
				}),
			/unsupported entry type/,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("rejects SemVer prerelease numeric identifiers with leading zeroes", () => {
	assert.throws(() => HcpClientassertreleaseidentity("ClaudeScience", "0.1.0-01"), /Invalid semantic version/);
	assert.doesNotThrow(() => HcpClientassertreleaseidentity("ClaudeScience", "0.1.0-rc.1"));
});

test("rejects archive path segments that cannot round-trip on Windows", () => {
	for (const entry of [
		"ClaudeScience/bad:name.txt",
		"ClaudeScience/trailing.",
		"ClaudeScience/trailing ",
		"ClaudeScience/AUX.txt",
	]) {
		assert.throws(
			() => HcpClientvalidatearchiveentrypath(entry, "ClaudeScience"),
			/not cross-platform safe/,
			entry,
		);
	}
	assert.equal(
		HcpClientvalidatearchiveentrypath("ClaudeScience/skills/literature-review/SKILL.md", "ClaudeScience"),
		"ClaudeScience/skills/literature-review/SKILL.md",
	);
});
