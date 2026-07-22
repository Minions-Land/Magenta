import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	handleLocalReleaseOutputFailure,
	LOCAL_RELEASE_FAILURE_SENTINEL,
	LOCAL_RELEASE_OUTPUT_SENTINEL,
	prepareLocalReleaseOutputDirectory,
} from "./local-release-output.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-local-release-output-"));
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot);
	return { repoRoot, root };
}

test("refuses output inside, equal to, or containing the repository", () => {
	const paths = fixture();
	try {
		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ outDir: join(paths.repoRoot, "output"), repoRoot: paths.repoRoot }),
			/outside the repository/u,
		);
		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ outDir: join(paths.repoRoot, "..output"), repoRoot: paths.repoRoot }),
			/outside the repository/u,
		);
		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ force: true, outDir: paths.repoRoot, repoRoot: paths.repoRoot }),
			/outside the repository/u,
		);
		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ force: true, outDir: paths.root, repoRoot: paths.repoRoot }),
			/must not contain the repository/u,
		);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("resolves symlinked parents before applying repository boundaries", (context) => {
	if (process.platform === "win32") context.skip("Windows symlink creation requires elevated privileges");
	const paths = fixture();
	const link = join(paths.root, "repo-link");
	try {
		symlinkSync(paths.repoRoot, link, "dir");
		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ outDir: join(link, "output"), repoRoot: paths.repoRoot }),
			/outside the repository/u,
		);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("force refuses an unowned directory and preserves its contents", () => {
	const paths = fixture();
	const output = join(paths.root, "unowned");
	const keep = join(output, "keep.txt");
	try {
		mkdirSync(output);
		writeFileSync(keep, "preserve me\n");
		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ force: true, outDir: output, repoRoot: paths.repoRoot }),
			/not owned by local-release/u,
		);
		assert.equal(readFileSync(keep, "utf8"), "preserve me\n");
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("owned output requires force and is replaced", () => {
	const paths = fixture();
	const output = join(paths.root, "owned");
	try {
		const created = prepareLocalReleaseOutputDirectory({ outDir: output, repoRoot: paths.repoRoot });
		assert.equal(created, realpathSync(output));
		assert.equal(existsSync(join(output, LOCAL_RELEASE_OUTPUT_SENTINEL)), true);
		const oldArtifact = join(output, "old.txt");
		writeFileSync(oldArtifact, "old\n");

		assert.throws(
			() => prepareLocalReleaseOutputDirectory({ outDir: output, repoRoot: paths.repoRoot }),
			/Use --force/u,
		);
		assert.equal(existsSync(oldArtifact), true);

		prepareLocalReleaseOutputDirectory({ force: true, outDir: output, repoRoot: paths.repoRoot });
		assert.equal(existsSync(oldArtifact), false);
		assert.equal(existsSync(join(output, LOCAL_RELEASE_OUTPUT_SENTINEL)), true);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("default output is marked as owned", () => {
	const paths = fixture();
	let output;
	try {
		output = prepareLocalReleaseOutputDirectory({ repoRoot: paths.repoRoot });
		assert.equal(existsSync(join(output, LOCAL_RELEASE_OUTPUT_SENTINEL)), true);
	} finally {
		if (output) rmSync(output, { force: true, recursive: true });
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("removes incomplete script-owned temporary output after failure", () => {
	const paths = fixture();
	let output;
	try {
		output = prepareLocalReleaseOutputDirectory({ repoRoot: paths.repoRoot });
		writeFileSync(join(output, "partial.tgz"), "partial\n");

		const disposition = handleLocalReleaseOutputFailure({ explicitOut: false, outputDirectory: output });

		assert.match(disposition, /removed incomplete temporary output/u);
		assert.equal(existsSync(output), false);
	} finally {
		if (output) rmSync(output, { force: true, recursive: true });
		rmSync(paths.root, { force: true, recursive: true });
	}
});

test("preserves and marks incomplete explicit output after failure", () => {
	const paths = fixture();
	const output = join(paths.root, "explicit-output");
	try {
		prepareLocalReleaseOutputDirectory({ outDir: output, repoRoot: paths.repoRoot });
		const partialArtifact = join(output, "partial.tgz");
		writeFileSync(partialArtifact, "partial\n");

		const disposition = handleLocalReleaseOutputFailure({ explicitOut: true, outputDirectory: output });

		assert.match(disposition, /preserved incomplete --out directory/u);
		assert.match(disposition, /Inspect it before using --force/u);
		assert.equal(readFileSync(partialArtifact, "utf8"), "partial\n");
		assert.equal(
			readFileSync(join(output, LOCAL_RELEASE_FAILURE_SENTINEL), "utf8"),
			"magenta-local-release-failed-v1\n",
		);
	} finally {
		rmSync(paths.root, { force: true, recursive: true });
	}
});
