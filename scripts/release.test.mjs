import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	RELEASE_MAIN_FETCH_ARGS,
	addUnreleasedSection,
	assertExpectedChangedPaths,
	compareVersions,
	createReleaseGitPlan,
	finalizeChangelog,
	isOfficialSourceRemote,
	parseChangedPaths,
	readActiveBrand,
	resolveReleaseVersion,
	updateBrandVersionSource,
} from "./release.mjs";

test("resolves product version bumps independently of workspace versions", () => {
	assert.equal(resolveReleaseVersion("0.0.23", "patch"), "0.0.24");
	assert.equal(resolveReleaseVersion("0.9.8", "minor"), "0.10.0");
	assert.equal(resolveReleaseVersion("9.8.7", "major"), "10.0.0");
	assert.equal(resolveReleaseVersion("0.80.2", "0.81.0"), "0.81.0");
	assert.equal(compareVersions("0.0.24", "0.0.23"), 1);
});

test("rejects invalid, non-increasing, or unsafe release targets", () => {
	assert.throws(() => resolveReleaseVersion("0.0.23", "v0.0.24"), /Invalid release target/u);
	assert.throws(() => resolveReleaseVersion("0.0.23", "0.0.23"), /must be greater/u);
	assert.throws(() => resolveReleaseVersion("0.0.23", "0.0.22"), /must be greater/u);
	assert.throws(() => resolveReleaseVersion("0.0.23", "01.0.0"), /Invalid release target/u);
	assert.throws(() => resolveReleaseVersion("9007199254740991.0.0", "major"), /safe integers/u);
});

test("updates only the active brand product version field", () => {
	const source = [
		"export const BRAND_CONFIG = {",
		'\tname: "Magenta",',
		'\tversion: "0.0.23",',
		"\tinfra: {",
		'\t\tpiVersion: "0.80.2",',
		'\t\tharnessVersion: "0.1.0",',
		"\t},",
		"};",
		"",
	].join("\n");
	const updated = updateBrandVersionSource(source, "0.0.23", "0.0.24");
	assert.match(updated, /version: "0\.0\.24"/u);
	assert.match(updated, /piVersion: "0\.80\.2"/u);
	assert.match(updated, /harnessVersion: "0\.1\.0"/u);
});

test("reads the active brand from valid TOML variants instead of a Pi package", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-brand-"));
	try {
		mkdirSync(join(root, "brands/magenta"), { recursive: true });
		writeFileSync(
			join(root, "brands/registry.toml"),
			["active='magenta'", "", "[[brands]]", "name='magenta'", "path='magenta/magenta.brand.ts'"].join(
				"\n",
			),
		);
		writeFileSync(
			join(root, "brands/magenta/magenta.brand.ts"),
			[
				"export const BRAND_CONFIG = {",
				'\tname: "Magenta",',
				'\tversion: "0.0.23",',
				'\tinfra: { piVersion: "0.80.2" },',
				"};",
			].join("\n"),
		);
		const brand = readActiveBrand(root);
		assert.equal(brand.displayName, "Magenta");
		assert.equal(brand.version, "0.0.23");
		assert.equal(brand.configRelativePath, "brands/magenta/magenta.brand.ts");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an active brand path outside the brands directory", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-brand-"));
	try {
		mkdirSync(join(root, "brands"), { recursive: true });
		writeFileSync(
			join(root, "brands/registry.toml"),
			["active = 'magenta'", "", "[[brands]]", "name = 'magenta'", "path = '../outside.ts'"].join("\n"),
		);
		assert.throws(() => readActiveBrand(root), /escapes the brands directory/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finalizes a non-empty Unreleased section and restores the next-cycle heading", () => {
	const source = [
		"# Changelog",
		"",
		"Intro.",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"- Release commands use the product version.",
		"",
		"## [0.0.23] - 2026-07-16",
		"- Previous release.",
		"",
	].join("\n");
	const released = finalizeChangelog(source, "0.0.24", "2026-07-17");
	assert.match(released, /## \[0\.0\.24\] - 2026-07-17/u);
	assert.doesNotMatch(released, /^## \[Unreleased\]$/mu);
	const nextCycle = addUnreleasedSection(released);
	assert.match(nextCycle, /Intro\.\n\n## \[Unreleased\]\n\n## \[0\.0\.24\]/u);
});

test("ignores changelog marker text inside prose and fenced examples", () => {
	const source = [
		"# Changelog",
		"",
		"The text `## [Unreleased]` names the required heading.",
		"",
		"```md",
		"## [Unreleased]",
		"```",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"- Safe release parsing.",
		"",
		"## [0.0.23] - 2026-07-16",
		"",
	].join("\n");
	const released = finalizeChangelog(source, "0.0.24", "2026-07-17");
	assert.match(released, /```md\n## \[Unreleased\]\n```/u);
	assert.match(released, /## \[0\.0\.24\] - 2026-07-17/u);
});

test("preserves CRLF when adding the next Unreleased heading", () => {
	const source = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"- Safe release parsing.",
		"",
		"## [0.0.23] - 2026-07-16",
		"",
	].join("\r\n");
	const released = finalizeChangelog(source, "0.0.24", "2026-07-17");
	const nextCycle = addUnreleasedSection(released);
	assert.match(nextCycle, /## \[Unreleased\]\r\n\r\n## \[0\.0\.24\]/u);
});

test("rejects empty, duplicate, or already-finalized changelog state", () => {
	const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.0.23] - 2026-07-16\n";
	assert.throws(() => finalizeChangelog(empty, "0.0.24", "2026-07-17"), /must contain/u);
	const duplicate = `${empty}\n## [Unreleased]\n`;
	assert.throws(() => finalizeChangelog(duplicate, "0.0.24", "2026-07-17"), /exactly one/u);
	assert.throws(() => addUnreleasedSection(empty), /already contains/u);
});

test("accepts only the exact release file set", () => {
	const expected = [
		"brands/magenta/magenta.brand.ts",
		"pi/coding-agent/CHANGELOG.md",
		"pi/coding-agent/src/brand-version.generated.ts",
	];
	assert.doesNotThrow(() => assertExpectedChangedPaths([...expected].reverse(), expected));
	assert.throws(
		() => assertExpectedChangedPaths([...expected, "pi/ai/src/providers/openrouter.models.ts"], expected),
		/unexpected paths/u,
	);
});

test("uses the official source remote and lease-protected fully qualified pushes", () => {
	assert.equal(isOfficialSourceRemote("git@github.com:Minions-Land/Magenta.git"), true);
	assert.equal(isOfficialSourceRemote("https://github.com/Minions-Land/Magenta"), true);
	assert.equal(isOfficialSourceRemote("git@github.com:someone/Magenta.git"), false);
	assert.deepEqual(RELEASE_MAIN_FETCH_ARGS, [
		"fetch",
		"origin",
		"+refs/heads/main:refs/remotes/origin/main",
	]);

	const remoteMainSha = "a".repeat(40);
	const plan = createReleaseGitPlan({ displayName: "Magenta", remoteMainSha, version: "0.0.24" });
	assert.deepEqual(plan.tagCreateArgs, ["tag", "-a", "v0.0.24", "-m", "Magenta CLI v0.0.24"]);
	assert.deepEqual(plan.mainPushArgs, [
		"push",
		`--force-with-lease=refs/heads/main:${remoteMainSha}`,
		"origin",
		"HEAD:refs/heads/main",
	]);
	assert.deepEqual(plan.tagPushArgs, ["push", "origin", "refs/tags/v0.0.24:refs/tags/v0.0.24"]);
	assert.equal(plan.releaseCommitArgs.includes("--only"), true);
	assert.equal(plan.nextCycleCommitArgs.includes("--only"), true);
});

test("parses porcelain paths and rejects rename or copy records", () => {
	assert.deepEqual(parseChangedPaths(" M file with spaces.md\0?? scripts/new-file.mjs\0"), [
		"file with spaces.md",
		"scripts/new-file.mjs",
	]);
	assert.throws(() => parseChangedPaths("R  renamed.md\0original.md\0"), /renamed or copied/u);
	assert.throws(() => parseChangedPaths("C  copied.md\0original.md\0"), /renamed or copied/u);
});

function git(cwd, args, { allowFailure = false } = {}) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}

function gitWithIdentity(cwd, args, options) {
	return git(cwd, ["-c", "user.name=Release Test", "-c", "user.email=release@example.com", ...args], options);
}

function createGitFixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-git-"));
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(root, ["init", "--bare", remote]);
	git(repo, ["init", "-b", "main"]);
	writeFileSync(join(repo, "version.txt"), "0.0.23\n");
	writeFileSync(join(repo, "CHANGELOG.md"), "## [Unreleased]\n");
	git(repo, ["add", "--", "version.txt", "CHANGELOG.md"]);
	gitWithIdentity(repo, ["commit", "-m", "initial"]);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-u", "origin", "main"]);
	git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
	return {
		initialHead: git(repo, ["rev-parse", "HEAD"]).stdout.trim(),
		remote,
		repo,
		root,
	};
}

test("Git plan creates an annotated release tag before the next-cycle commit", () => {
	const fixture = createGitFixture();
	try {
		const plan = createReleaseGitPlan({
			displayName: "Magenta",
			remoteMainSha: fixture.initialHead,
			version: "0.0.24",
		});
		writeFileSync(join(fixture.repo, "version.txt"), "0.0.24\n");
		gitWithIdentity(fixture.repo, [...plan.releaseCommitArgs, "version.txt"]);
		const releaseCommit = git(fixture.repo, ["rev-parse", "HEAD"]).stdout.trim();
		gitWithIdentity(fixture.repo, plan.tagCreateArgs);
		writeFileSync(join(fixture.repo, "CHANGELOG.md"), "## [Unreleased]\n\n## [0.0.24]\n");
		gitWithIdentity(fixture.repo, [...plan.nextCycleCommitArgs, "CHANGELOG.md"]);
		const nextCycleCommit = git(fixture.repo, ["rev-parse", "HEAD"]).stdout.trim();
		git(fixture.repo, plan.mainPushArgs);
		git(fixture.repo, plan.tagPushArgs);

		assert.notEqual(nextCycleCommit, releaseCommit);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).stdout.trim(),
			nextCycleCommit,
		);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "cat-file", "-t", "v0.0.24"]).stdout.trim(),
			"tag",
		);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "v0.0.24^{}"]).stdout.trim(),
			releaseCommit,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("lease-protected main push rejects a concurrent remote advance", () => {
	const fixture = createGitFixture();
	try {
		writeFileSync(join(fixture.repo, "version.txt"), "local release\n");
		gitWithIdentity(fixture.repo, ["commit", "--only", "-m", "local", "--", "version.txt"]);
		const plan = createReleaseGitPlan({
			displayName: "Magenta",
			remoteMainSha: fixture.initialHead,
			version: "0.0.24",
		});

		const other = join(fixture.root, "other");
		git(fixture.root, ["clone", fixture.remote, other]);
		writeFileSync(join(other, "version.txt"), "remote advance\n");
		gitWithIdentity(other, ["commit", "--only", "-m", "remote", "--", "version.txt"]);
		git(other, ["push", "origin", "main"]);
		const remoteAdvance = git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).stdout.trim();

		const rejected = git(fixture.repo, plan.mainPushArgs, { allowFailure: true });
		assert.notEqual(rejected.status, 0);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).stdout.trim(),
			remoteAdvance,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
