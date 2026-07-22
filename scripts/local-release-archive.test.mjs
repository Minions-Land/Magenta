import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAndVerifyLocalBinaryArchive,
	localBinaryArchiveName,
} from "./local-release-archive.mjs";

function fixture(binaryFile = "magenta") {
	const root = mkdtempSync(join(tmpdir(), "magenta-local-release-archive-"));
	const targetDirectory = join(root, "bun");
	mkdirSync(join(targetDirectory, "runtime"), { recursive: true });
	mkdirSync(join(targetDirectory, "tools"), { recursive: true });
	writeFileSync(join(targetDirectory, binaryFile), "binary bytes\n");
	writeFileSync(join(targetDirectory, "runtime", "runtime.txt"), "runtime\n");
	writeFileSync(join(targetDirectory, "tools", "tool.txt"), "tool\n");
	writeFileSync(join(targetDirectory, "magenta-release.json"), '{"version":"0.0.29"}\n');
	return { root, targetDirectory };
}

function commandExists(command) {
	return spawnSync(command, ["--help"], { stdio: "ignore" }).status === 0;
}

test("rebuilds and verifies the Unix archive from the completed binary directory", () => {
	const paths = fixture();
	try {
		chmodSync(join(paths.targetDirectory, "magenta"), 0o755);
		const archivePath = createAndVerifyLocalBinaryArchive({
			archiveDirectory: paths.root,
			binaryName: "magenta",
			platform: "linux-x64",
			requiredEntries: ["runtime", "tools", "magenta-release.json"],
			targetDirectory: paths.targetDirectory,
		});
		const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
		assert.match(listing, /^magenta\/runtime\/runtime\.txt$/mu);
		assert.match(listing, /^magenta\/tools\/tool\.txt$/mu);
		assert.match(listing, /^magenta\/magenta-release\.json$/mu);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("does not replace an existing archive when a required resource is missing", () => {
	const paths = fixture();
	const archivePath = join(paths.root, localBinaryArchiveName("magenta", "linux-x64"));
	try {
		writeFileSync(archivePath, "previous archive\n");
		assert.throws(
			() =>
				createAndVerifyLocalBinaryArchive({
					archiveDirectory: paths.root,
					binaryName: "magenta",
					platform: "linux-x64",
					requiredEntries: ["runtime", "missing-resource"],
					targetDirectory: paths.targetDirectory,
				}),
			/missing required archive entry: missing-resource/u,
		);
		assert.equal(readFileSync(archivePath, "utf8"), "previous archive\n");
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("uses a rollback backup when the platform cannot rename over an existing archive", () => {
	const paths = fixture();
	const archivePath = join(paths.root, localBinaryArchiveName("magenta", "linux-x64"));
	let replacementAttempts = 0;
	try {
		writeFileSync(archivePath, "previous archive\n");
		createAndVerifyLocalBinaryArchive({
			archiveDirectory: paths.root,
			binaryName: "magenta",
			platform: "linux-x64",
			renameFile: (source, destination) => {
				if (destination === archivePath) {
					replacementAttempts += 1;
					if (replacementAttempts === 1) {
						throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
					}
				}
				renameSync(source, destination);
			},
			requiredEntries: ["runtime", "tools", "magenta-release.json"],
			targetDirectory: paths.targetDirectory,
		});

		assert.equal(replacementAttempts, 2);
		assert.notEqual(readFileSync(archivePath, "utf8"), "previous archive\n");
		assert.deepEqual(
			readdirSync(paths.root).filter((entry) => entry.startsWith(".magenta-local-archive")),
			[],
		);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("restores an existing archive when the fallback replacement rename fails", () => {
	const paths = fixture();
	const archivePath = join(paths.root, localBinaryArchiveName("magenta", "linux-x64"));
	let replacementAttempts = 0;
	try {
		writeFileSync(archivePath, "previous archive\n");
		assert.throws(
			() =>
				createAndVerifyLocalBinaryArchive({
					archiveDirectory: paths.root,
					binaryName: "magenta",
					platform: "linux-x64",
					renameFile: (source, destination) => {
						const restoringBackup = source.includes(".magenta-local-archive-backup-");
						if (destination === archivePath && !restoringBackup) {
							replacementAttempts += 1;
							const error = new Error(replacementAttempts === 1 ? "destination exists" : "rename failed");
							throw Object.assign(error, { code: replacementAttempts === 1 ? "EEXIST" : "EIO" });
						}
						renameSync(source, destination);
					},
					requiredEntries: ["runtime", "tools", "magenta-release.json"],
					targetDirectory: paths.targetDirectory,
				}),
			/existing archive was restored/u,
		);

		assert.equal(replacementAttempts, 2);
		assert.equal(readFileSync(archivePath, "utf8"), "previous archive\n");
		assert.deepEqual(
			readdirSync(paths.root).filter((entry) => entry.startsWith(".magenta-local-archive")),
			[],
		);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("preserves a recovery copy when restoring the previous archive also fails", () => {
	const paths = fixture();
	const archivePath = join(paths.root, localBinaryArchiveName("magenta", "linux-x64"));
	let replacementAttempts = 0;
	try {
		writeFileSync(archivePath, "previous archive\n");
		let failure;
		try {
			createAndVerifyLocalBinaryArchive({
				archiveDirectory: paths.root,
				binaryName: "magenta",
				platform: "linux-x64",
				renameFile: (source, destination) => {
					const restoringBackup = source.includes(".magenta-local-archive-backup-");
					if (restoringBackup) throw Object.assign(new Error("restore failed"), { code: "EPERM" });
					if (destination === archivePath) {
						replacementAttempts += 1;
						throw Object.assign(new Error("replacement failed"), {
							code: replacementAttempts === 1 ? "EEXIST" : "EIO",
						});
					}
					renameSync(source, destination);
				},
				requiredEntries: ["runtime", "tools", "magenta-release.json"],
				targetDirectory: paths.targetDirectory,
			});
		} catch (error) {
			failure = error;
		}

		assert.match(failure?.message ?? "", /Recover the previous archive from:/u);
		const recoveryPath = failure.message.slice(failure.message.indexOf(": ") + 2);
		assert.equal(readFileSync(recoveryPath, "utf8"), "previous archive\n");
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("rebuilds the Windows zip with resources at the archive root", (context) => {
	if (!commandExists("zip") || !commandExists("unzip")) context.skip("zip and unzip are required");
	const paths = fixture("magenta.exe");
	try {
		const archivePath = createAndVerifyLocalBinaryArchive({
			archiveDirectory: paths.root,
			binaryName: "magenta",
			platform: "windows-x64",
			requiredEntries: ["runtime", "tools", "magenta-release.json"],
			targetDirectory: paths.targetDirectory,
		});
		const listing = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
		assert.match(listing, /^runtime\/runtime\.txt$/mu);
		assert.match(listing, /^tools\/tool\.txt$/mu);
		assert.match(listing, /^magenta-release\.json$/mu);
		assert.doesNotMatch(listing, /^magenta\//mu);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});
