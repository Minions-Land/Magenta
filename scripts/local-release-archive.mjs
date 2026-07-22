import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

function run(command, args, cwd) {
	try {
		execFileSync(command, args, {
			cwd,
			env: { ...process.env, COPYFILE_DISABLE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (error) {
		const detail = error?.stderr ? String(error.stderr).trim() : "";
		throw new Error(
			`Could not create or inspect local binary archive with ${command}: ${error.message}${detail ? ` (${detail})` : ""}`,
			{ cause: error },
		);
	}
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeManifest(root, compareExecutableMode) {
	const manifest = new Map();
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).replaceAll("\\", "/");
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				throw new Error(`Local binary archive input contains a symlink: ${relativePath} -> ${readlinkSync(path)}`);
			}
			if (stat.isDirectory()) {
				manifest.set(relativePath, "directory");
				visit(path);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Local binary archive input contains an unsupported entry: ${relativePath}`);
			const executable = compareExecutableMode && (stat.mode & 0o111) !== 0 ? ":executable" : "";
			manifest.set(relativePath, `file:${stat.size}:${sha256(path)}${executable}`);
		}
	};
	visit(root);
	return [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function assertRequiredEntries(targetDirectory, binaryName, platform, requiredEntries) {
	const executableName = platform.startsWith("windows-") ? `${binaryName}.exe` : binaryName;
	for (const entry of [executableName, ...requiredEntries]) {
		if (!existsSync(join(targetDirectory, entry))) {
			throw new Error(`Local binary release is missing required archive entry: ${entry}`);
		}
	}
}

export function localBinaryArchiveName(binaryName, platform) {
	return platform.startsWith("windows-") ? `${binaryName}-${platform}.zip` : `${binaryName}-${platform}.tar.gz`;
}

function replaceArchiveWithRollback(temporaryArchive, archivePath, renameFile) {
	try {
		renameFile(temporaryArchive, archivePath);
		return;
	} catch (directReplacementError) {
		if (!existsSync(archivePath)) throw directReplacementError;

		const backupRoot = mkdtempSync(join(dirname(archivePath), ".magenta-local-archive-backup-"));
		const backupArchive = join(backupRoot, basename(archivePath));
		let preserveBackup = false;
		try {
			try {
				renameFile(archivePath, backupArchive);
			} catch (backupError) {
				throw new AggregateError(
					[directReplacementError, backupError],
					`Could not replace local binary archive, and the existing archive remains in place: ${archivePath}`,
				);
			}

			try {
				renameFile(temporaryArchive, archivePath);
			} catch (replacementError) {
				try {
					renameFile(backupArchive, archivePath);
				} catch (restoreError) {
					preserveBackup = true;
					throw new AggregateError(
						[replacementError, restoreError],
						`Could not replace or restore the local binary archive. Recover the previous archive from: ${backupArchive}`,
					);
				}
				throw new Error(
					`Could not replace local binary archive; the existing archive was restored: ${archivePath}`,
					{ cause: replacementError },
				);
			}
		} finally {
			if (!preserveBackup) rmSync(backupRoot, { force: true, recursive: true });
		}
	}
}

export function createAndVerifyLocalBinaryArchive({
	archiveDirectory,
	binaryName,
	platform,
	renameFile = renameSync,
	requiredEntries,
	targetDirectory,
}) {
	assertRequiredEntries(targetDirectory, binaryName, platform, requiredEntries);
	const windowsArchive = platform.startsWith("windows-");
	const expectedManifest = treeManifest(targetDirectory, !windowsArchive);
	const archiveName = localBinaryArchiveName(binaryName, platform);
	const archivePath = join(archiveDirectory, archiveName);
	const temporaryRoot = mkdtempSync(join(archiveDirectory, ".magenta-local-archive-"));
	const temporaryArchive = join(temporaryRoot, archiveName);
	const extractionRoot = join(temporaryRoot, "extracted");
	mkdirSync(extractionRoot);

	try {
		let extractedDirectory;
		if (windowsArchive) {
			run("zip", ["-q", "-r", temporaryArchive, "."], targetDirectory);
			run("unzip", ["-q", temporaryArchive, "-d", extractionRoot], archiveDirectory);
			extractedDirectory = extractionRoot;
		} else {
			const stagingRoot = join(temporaryRoot, "staging");
			mkdirSync(stagingRoot);
			cpSync(targetDirectory, join(stagingRoot, binaryName), { preserveTimestamps: true, recursive: true });
			run("tar", ["-czf", temporaryArchive, binaryName], stagingRoot);
			run("tar", ["-xzf", temporaryArchive, "-C", extractionRoot], archiveDirectory);
			extractedDirectory = join(extractionRoot, binaryName);
		}

		assertRequiredEntries(extractedDirectory, binaryName, platform, requiredEntries);
		const actualManifest = treeManifest(extractedDirectory, !windowsArchive);
		if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
			const actual = new Map(actualManifest);
			const expected = new Map(expectedManifest);
			const differingPath = [...new Set([...actual.keys(), ...expected.keys()])]
				.sort()
				.find((path) => actual.get(path) !== expected.get(path));
			throw new Error(
				`Local binary archive contents do not match the completed binary directory at ${differingPath ?? "an unknown path"}.`,
			);
		}

		replaceArchiveWithRollback(temporaryArchive, archivePath, renameFile);
		return archivePath;
	} finally {
		rmSync(temporaryRoot, { force: true, recursive: true });
	}
}
