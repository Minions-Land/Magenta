import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LOCAL_RELEASE_OUTPUT_SENTINEL = ".magenta-local-release-output";
export const LOCAL_RELEASE_FAILURE_SENTINEL = ".magenta-local-release-failed";
const LOCAL_RELEASE_OUTPUT_MARKER = "magenta-local-release-output-v1\n";
const LOCAL_RELEASE_FAILURE_MARKER = "magenta-local-release-failed-v1\n";

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function canonicalizeCandidate(path) {
	if (existsSync(path)) return realpathSync(path);

	const suffix = [];
	let ancestor = path;
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		suffix.unshift(basename(ancestor));
		ancestor = parent;
	}
	return resolve(realpathSync(ancestor), ...suffix);
}

function assertOutsideRepository(outputDirectory, repoRoot) {
	const canonicalRepoRoot = realpathSync(repoRoot);
	if (dirname(outputDirectory) === outputDirectory) {
		throw new Error("Output directory must not be the filesystem root");
	}
	if (isInsidePath(outputDirectory, canonicalRepoRoot)) {
		throw new Error(`Output directory must be outside the repository: ${outputDirectory}`);
	}
	if (isInsidePath(canonicalRepoRoot, outputDirectory)) {
		throw new Error(`Output directory must not contain the repository: ${outputDirectory}`);
	}
}

function writeOwnershipMarker(outputDirectory) {
	if (readdirSync(outputDirectory).length !== 0) {
		throw new Error(`Refusing to claim a non-empty output directory: ${outputDirectory}`);
	}
	writeFileSync(join(outputDirectory, LOCAL_RELEASE_OUTPUT_SENTINEL), LOCAL_RELEASE_OUTPUT_MARKER, {
		flag: "wx",
		mode: 0o600,
	});
}

function assertOwnedOutputDirectory(outputDirectory) {
	const markerPath = join(outputDirectory, LOCAL_RELEASE_OUTPUT_SENTINEL);
	let markerStat;
	try {
		markerStat = lstatSync(markerPath);
	} catch {
		throw new Error(`Refusing to replace a directory not owned by local-release: ${outputDirectory}`);
	}
	if (!markerStat.isFile() || readFileSync(markerPath, "utf8") !== LOCAL_RELEASE_OUTPUT_MARKER) {
		throw new Error(`Refusing to replace a directory not owned by local-release: ${outputDirectory}`);
	}
}

export function prepareLocalReleaseOutputDirectory({ force = false, outDir, repoRoot }) {
	if (!outDir) {
		const outputDirectory = realpathSync(mkdtempSync(join(tmpdir(), "pi-local-release-")));
		try {
			assertOutsideRepository(outputDirectory, repoRoot);
			writeOwnershipMarker(outputDirectory);
			return outputDirectory;
		} catch (error) {
			rmSync(outputDirectory, { force: true, recursive: true });
			throw error;
		}
	}

	const requestedPath = resolve(outDir);
	if (existsSync(requestedPath) && !lstatSync(requestedPath).isDirectory()) {
		throw new Error(`Output path exists and is not a directory: ${requestedPath}`);
	}
	const outputDirectory = canonicalizeCandidate(requestedPath);
	assertOutsideRepository(outputDirectory, repoRoot);

	if (existsSync(requestedPath)) {
		if (!force) throw new Error(`Output directory already exists. Use --force to replace it: ${outputDirectory}`);
		assertOwnedOutputDirectory(outputDirectory);
		rmSync(outputDirectory, { force: true, recursive: true });
	}

	mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
	writeOwnershipMarker(outputDirectory);
	return outputDirectory;
}

export function handleLocalReleaseOutputFailure({ explicitOut, outputDirectory }) {
	assertOwnedOutputDirectory(outputDirectory);
	if (!explicitOut) {
		rmSync(outputDirectory, { force: true, recursive: true });
		return `Local release failed; removed incomplete temporary output: ${outputDirectory}`;
	}

	const failureMarker = join(outputDirectory, LOCAL_RELEASE_FAILURE_SENTINEL);
	writeFileSync(failureMarker, LOCAL_RELEASE_FAILURE_MARKER, { flag: "wx", mode: 0o600 });
	return [
		`Local release failed; preserved incomplete --out directory: ${outputDirectory}`,
		`Failure marker: ${failureMarker}`,
		"Inspect it before using --force to replace it.",
	].join("\n");
}
