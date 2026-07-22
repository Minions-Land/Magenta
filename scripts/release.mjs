#!/usr/bin/env node
/**
 * Release the active Magenta CLI product version.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Product versions come from the active brand configuration. Pi workspace
 * package versions are independent infrastructure versions and are never
 * changed by this script.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readActiveBrandMetadata } from "./brand-metadata.mjs";
import { runReleaseGate } from "./release-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_RELATIVE_PATH = "pi/coding-agent/CHANGELOG.md";
const GENERATED_VERSION_RELATIVE_PATH = "pi/coding-agent/src/brand-version.generated.ts";
const OFFICIAL_SOURCE_REMOTE = "github.com/Minions-Land/Magenta";
const PUBLIC_RELEASE_API = "https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest";
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const RELEASE_MAIN_FETCH_ARGS = [
	"fetch",
	"origin",
	"+refs/heads/main:refs/remotes/origin/main",
];

function parseVersion(version, label = "version") {
	const match = SEMVER_RE.exec(version);
	if (!match) throw new Error(`Invalid ${label}: ${version}. Expected x.y.z without a leading v.`);
	const parts = match.slice(1).map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part))) {
		throw new Error(`Invalid ${label}: ${version}. Version parts must be safe integers.`);
	}
	return parts;
}

export function compareVersions(left, right) {
	const leftParts = parseVersion(left, "version");
	const rightParts = parseVersion(right, "version");
	for (let index = 0; index < leftParts.length; index++) {
		const difference = leftParts[index] - rightParts[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export function resolveReleaseVersion(currentVersion, target) {
	const [major, minor, patch] = parseVersion(currentVersion, "current product version");
	let version;
	if (BUMP_TYPES.has(target)) {
		if (target === "major") version = `${major + 1}.0.0`;
		else if (target === "minor") version = `${major}.${minor + 1}.0`;
		else version = `${major}.${minor}.${patch + 1}`;
	} else {
		parseVersion(target, "release target");
		if (compareVersions(target, currentVersion) <= 0) {
			throw new Error(`Release target ${target} must be greater than current product version ${currentVersion}.`);
		}
		version = target;
	}
	parseVersion(version, "resolved release version");
	return version;
}

export function readActiveBrand(root = REPO_ROOT) {
	const brand = readActiveBrandMetadata(root);
	parseVersion(brand.version, "active brand product version");
	return brand;
}

export function assertLatestPublishedVersion(currentVersion, release) {
	parseVersion(currentVersion, "active brand product version");
	if (!release || typeof release !== "object") throw new Error("Latest public CLI release metadata is missing.");
	if (release.draft !== false || release.prerelease !== false) {
		throw new Error("Latest public CLI release metadata must describe a published, non-prerelease release.");
	}
	if (typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) {
		throw new Error("Latest public CLI release has no exact vMAJOR.MINOR.PATCH tag.");
	}
	const publishedVersion = release.tag_name.slice(1);
	parseVersion(publishedVersion, "latest public CLI release version");
	if (publishedVersion !== currentVersion) {
		throw new Error(
			`Active brand version ${currentVersion} does not match latest public CLI release ${publishedVersion}. Repair or rerun the existing version before creating another source tag.`,
		);
	}
	return publishedVersion;
}

export async function verifyLatestPublishedVersion(currentVersion, fetchImplementation = fetch) {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "Magenta-release-preflight",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	let response;
	try {
		response = await fetchImplementation(PUBLIC_RELEASE_API, {
			headers,
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		throw new Error(
			`Could not query the latest public CLI release: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.ok) {
		throw new Error(`Could not query the latest public CLI release: GitHub API returned ${response.status}.`);
	}
	let release;
	try {
		release = await response.json();
	} catch {
		throw new Error("Could not parse the latest public CLI release metadata.");
	}
	return assertLatestPublishedVersion(currentVersion, release);
}

export function updateBrandVersionSource(source, currentVersion, nextVersion) {
	parseVersion(nextVersion, "next product version");
	const matches = [...source.matchAll(/^(\s*version:\s*)"([^"]+)"(\s*,?\s*)$/gmu)];
	if (matches.length !== 1) {
		throw new Error(`Expected exactly one product version field in the active brand config, found ${matches.length}.`);
	}
	const match = matches[0];
	if (match[2] !== currentVersion) {
		throw new Error(`Brand config version ${match[2]} does not match expected current version ${currentVersion}.`);
	}
	const replacement = `${match[1]}"${nextVersion}"${match[3]}`;
	return `${source.slice(0, match.index)}${replacement}${source.slice((match.index ?? 0) + match[0].length)}`;
}

function markdownSecondLevelHeadings(source) {
	const headings = [];
	let offset = 0;
	let fence;
	while (offset < source.length) {
		const newline = source.indexOf("\n", offset);
		const chunkEnd = newline >= 0 ? newline : source.length;
		const rawLine = source.slice(offset, chunkEnd);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
		if (!fence && fenceMatch) {
			fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
		} else if (fence) {
			if (
				fenceMatch &&
				fenceMatch[1][0] === fence.character &&
				fenceMatch[1].length >= fence.length &&
				fenceMatch[2].trim() === ""
			) {
				fence = undefined;
			}
		} else {
			const heading = line.match(/^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u);
			if (heading) headings.push({ end: offset + line.length, start: offset, text: heading[1].trimEnd() });
		}
		offset = newline >= 0 ? newline + 1 : source.length;
	}
	return headings;
}

function markdownLinesOutsideFences(source) {
	const lines = [];
	let fence;
	for (const rawLine of source.split(/\r?\n/u)) {
		const fenceMatch = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
		if (!fence && fenceMatch) {
			fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
			continue;
		}
		if (fence) {
			if (
				fenceMatch &&
				fenceMatch[1][0] === fence.character &&
				fenceMatch[1].length >= fence.length &&
				fenceMatch[2].trim() === ""
			) {
				fence = undefined;
			}
			continue;
		}
		lines.push(rawLine);
	}
	return lines;
}

export function extractReleaseNotes(source, version) {
	parseVersion(version, "release version");
	const headings = markdownSecondLevelHeadings(source);
	const versionPrefix = `[${version}]`;
	const matchingHeadings = headings.filter((heading) => heading.text.startsWith(versionPrefix));
	if (matchingHeadings.length !== 1) {
		throw new Error(`Expected exactly one changelog heading for release ${version}, found ${matchingHeadings.length}.`);
	}
	const releaseHeading = matchingHeadings[0];
	const escapedVersion = version.replaceAll(".", "\\.");
	if (!new RegExp(`^\\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "u").test(releaseHeading.text)) {
		throw new Error(`Changelog heading for release ${version} must include an ISO release date.`);
	}
	const headingIndex = headings.indexOf(releaseHeading);
	const bodyEnd = headings[headingIndex + 1]?.start ?? source.length;
	const body = source.slice(releaseHeading.end, bodyEnd).trim();
	const visibleLines = markdownLinesOutsideFences(body);
	if (!visibleLines.some((line) => /^ {0,3}###[ \t]+\S/u.test(line))) {
		throw new Error(`Changelog release ${version} has no subsection outside a code fence.`);
	}
	if (!visibleLines.some((line) => /^ {0,3}-[ \t]+\S/u.test(line))) {
		throw new Error(`Changelog release ${version} has no non-empty change entry outside a code fence.`);
	}
	return `${body}\n`;
}

export function finalizeChangelog(source, version, date) {
	parseVersion(version, "release version");
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`Invalid release date: ${date}.`);
	const headings = markdownSecondLevelHeadings(source);
	const unreleased = headings.filter((heading) => heading.text === "[Unreleased]");
	if (unreleased.length !== 1) {
		throw new Error(`Expected exactly one ## [Unreleased] heading, found ${unreleased.length}.`);
	}
	if (headings.some((heading) => heading.text.startsWith(`[${version}]`))) {
		throw new Error(`Changelog already contains release ${version}.`);
	}

	const headingIndex = headings.indexOf(unreleased[0]);
	const bodyEnd = headings[headingIndex + 1]?.start ?? source.length;
	const body = source.slice(unreleased[0].end, bodyEnd);
	if (!/^###\s+\S/mu.test(body) || !/^-\s+\S/mu.test(body)) {
		throw new Error("The Unreleased changelog section must contain a subsection and at least one entry.");
	}
	const replacement = `## [${version}] - ${date}`;
	return `${source.slice(0, unreleased[0].start)}${replacement}${source.slice(unreleased[0].end)}`;
}

export function addUnreleasedSection(source) {
	const headings = markdownSecondLevelHeadings(source);
	if (headings.some((heading) => heading.text === "[Unreleased]")) {
		throw new Error("Changelog already contains an Unreleased section.");
	}
	const firstRelease = headings.find((heading) => /^\[\d+\.\d+\.\d+\](?: - \d{4}-\d{2}-\d{2})?$/u.test(heading.text));
	if (!firstRelease) throw new Error("Could not find the first released changelog heading.");
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	return `${source.slice(0, firstRelease.start)}## [Unreleased]${newline}${newline}${source.slice(firstRelease.start)}`;
}

export function isOfficialSourceRemote(url) {
	const normalized = url.trim().replace(/\/$/u, "").replace(/\.git$/u, "").toLowerCase();
	return new Set([
		"git@github.com:minions-land/magenta",
		"https://github.com/minions-land/magenta",
		"ssh://git@github.com/minions-land/magenta",
	]).has(normalized);
}

export function createReleaseGitPlan({ displayName, remoteMainSha, version }) {
	parseVersion(version, "release version");
	if (!/^[0-9a-f]{40,64}$/u.test(remoteMainSha)) throw new Error(`Invalid origin/main object id: ${remoteMainSha}`);
	const tag = `v${version}`;
	return {
		mainPushArgs: [
			"push",
			`--force-with-lease=refs/heads/main:${remoteMainSha}`,
			"origin",
			"HEAD:refs/heads/main",
		],
		nextCycleCommitArgs: ["commit", "--only", "-m", "Add [Unreleased] section for next cycle", "--"],
		releaseCommitArgs: ["commit", "--only", "-m", `release: ${displayName} CLI v${version}`, "--"],
		tag,
		tagCreateArgs: ["tag", "-a", tag, "-m", `${displayName} CLI v${version}`],
		tagPushArgs: ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
	};
}

function executableName(command) {
	return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function formatCommand(command, args) {
	return [command, ...args]
		.map((part) => (/^[A-Za-z0-9_./:@=+^-]+$/u.test(part) ? part : JSON.stringify(part)))
		.join(" ");
}

function run(command, args = [], { capture = false } = {}) {
	console.log(`$ ${formatCommand(command, args)}`);
	try {
		return execFileSync(executableName(command), args, {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
	} catch (error) {
		const detail = typeof error?.stderr === "string" ? error.stderr.trim() : "";
		throw new Error(`Command failed: ${formatCommand(command, args)}${detail ? `\n${detail}` : ""}`, {
			cause: error,
		});
	}
}

function gitOutput(args) {
	return run("git", args, { capture: true }).trim();
}

function safeGitOutput(args) {
	try {
		return gitOutput(args);
	} catch {
		return undefined;
	}
}

export function parseChangedPaths(output) {
	if (!output) return [];
	return output
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const status = record.slice(0, 2);
			if (status.includes("R") || status.includes("C")) {
				throw new Error(`Release preparation does not accept renamed or copied paths: ${record}`);
			}
			return record.slice(3).replaceAll("\\", "/");
		});
}

function changedPaths() {
	return parseChangedPaths(run("git", ["status", "--porcelain=v1", "-z"], { capture: true }));
}

export function assertExpectedChangedPaths(actualPaths, expectedPaths) {
	const actual = [...new Set(actualPaths)].sort();
	const expected = [...new Set(expectedPaths)].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`Release preparation changed unexpected paths.\nExpected: ${expected.join(", ")}\nActual: ${actual.join(", ")}`,
		);
	}
}

function assertChangedPaths(expectedPaths) {
	assertExpectedChangedPaths(changedPaths(), expectedPaths);
}

function ensureReleasePreconditions() {
	if (gitOutput(["status", "--porcelain"])) throw new Error("Working directory must be clean before releasing.");
	const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== "main") throw new Error(`Release must run from main, not ${branch}.`);
	const pushUrl = gitOutput(["remote", "get-url", "--push", "origin"]);
	if (!isOfficialSourceRemote(pushUrl)) {
		throw new Error(`origin push URL must target ${OFFICIAL_SOURCE_REMOTE}, found ${pushUrl}.`);
	}

	run("git", RELEASE_MAIN_FETCH_ARGS);
	const initialHead = gitOutput(["rev-parse", "HEAD"]);
	const remoteMainSha = gitOutput(["rev-parse", "refs/remotes/origin/main"]);
	if (initialHead !== remoteMainSha) {
		throw new Error(
			`main must exactly match origin/main before releasing (HEAD=${initialHead}, origin/main=${remoteMainSha}).`,
		);
	}
	return { initialHead, pushUrl, remoteMainSha };
}

function ensureTagAvailable(version) {
	const tag = `v${version}`;
	if (gitOutput(["tag", "--list", tag])) throw new Error(`Local tag already exists: ${tag}.`);
	if (gitOutput(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])) {
		throw new Error(`Remote tag already exists: ${tag}.`);
	}
}

function restoreReleaseFiles(snapshots, root = REPO_ROOT) {
	for (const [path, content] of snapshots) writeFileSync(resolve(root, path), content);
}

export function rollbackReleasePreparation({
	buildArtifactsTouched,
	cleanBuildArtifacts = () => run("npm", ["run", "clean"]),
	root = REPO_ROOT,
	snapshots,
}) {
	restoreReleaseFiles(snapshots, root);
	if (buildArtifactsTouched) cleanBuildArtifacts();
}

function printRecovery({ currentHead, initialHead, mainPushed, plan, tagPushed }) {
	console.error("Release stopped after creating local release state; no automatic history rewrite was attempted.");
	console.error(`Initial HEAD: ${initialHead}`);
	console.error(`Current HEAD: ${currentHead ?? "unknown"}`);
	if (mainPushed && !tagPushed) {
		console.error(`main was pushed but ${plan.tag} was not. Retry only the tag push after inspection:`);
		console.error(`  ${formatCommand("git", plan.tagPushArgs)}`);
	} else if (!mainPushed) {
		console.error("main was not pushed. Inspect the local commits and annotated tag before choosing recovery:");
		console.error("  git log --oneline origin/main..HEAD");
		console.error(`  git show ${plan.tag}`);
		console.error("To resume after inspection, push main with the recorded lease, then push the tag:");
		console.error(`  ${formatCommand("git", plan.mainPushArgs)}`);
		console.error(`  ${formatCommand("git", plan.tagPushArgs)}`);
	} else {
		console.error(`${plan.tag} was pushed; the immutable release workflow may already be running.`);
	}
}

export async function releaseMain(args = process.argv.slice(2)) {
	if (args.length !== 1 || (!BUMP_TYPES.has(args[0]) && !SEMVER_RE.test(args[0]))) {
		throw new Error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	}

	console.log("\n=== Magenta CLI Release ===\n");
	const preconditions = ensureReleasePreconditions();
	const brand = readActiveBrand();
	await verifyLatestPublishedVersion(brand.version);
	const version = resolveReleaseVersion(brand.version, args[0]);
	ensureTagAvailable(version);
	const plan = createReleaseGitPlan({
		displayName: brand.displayName,
		remoteMainSha: preconditions.remoteMainSha,
		version,
	});

	const changelogPath = resolve(REPO_ROOT, CHANGELOG_RELATIVE_PATH);
	const generatedVersionPath = resolve(REPO_ROOT, GENERATED_VERSION_RELATIVE_PATH);
	const changelogSource = readFileSync(changelogPath, "utf8");
	const generatedVersionSource = readFileSync(generatedVersionPath, "utf8");
	const snapshots = new Map([
		[brand.configRelativePath, brand.configSource],
		[CHANGELOG_RELATIVE_PATH, changelogSource],
		[GENERATED_VERSION_RELATIVE_PATH, generatedVersionSource],
	]);
	const date = new Date().toISOString().slice(0, 10);
	const releaseChangelog = finalizeChangelog(changelogSource, version, date);
	const nextBrandSource = updateBrandVersionSource(brand.configSource, brand.version, version);
	const releasePaths = [brand.configRelativePath, CHANGELOG_RELATIVE_PATH, GENERATED_VERSION_RELATIVE_PATH];
	let buildArtifactsTouched = false;
	let mainPushed = false;
	let tagPushed = false;

	try {
		console.log(`Product: ${brand.displayName}`);
		console.log(`Version: ${brand.version} -> ${version}`);
		writeFileSync(brand.configPath, nextBrandSource);
		writeFileSync(changelogPath, releaseChangelog);
		run(process.execPath, ["scripts/generate-brand-version.mjs"]);
		run(process.execPath, ["scripts/verify-brand-version.mjs", "--expected", version]);
		buildArtifactsTouched = true;
		runReleaseGate({ expectedVersion: version, runCommand: run });
		assertChangedPaths(releasePaths);
		run("git", [...plan.releaseCommitArgs, ...releasePaths]);
		assertChangedPaths([]);
		run("git", plan.tagCreateArgs);

		const releasedChangelog = readFileSync(changelogPath, "utf8");
		writeFileSync(changelogPath, addUnreleasedSection(releasedChangelog));
		assertChangedPaths([CHANGELOG_RELATIVE_PATH]);
		run("git", [...plan.nextCycleCommitArgs, CHANGELOG_RELATIVE_PATH]);
		assertChangedPaths([]);

		run("git", plan.mainPushArgs);
		mainPushed = true;
		run("git", plan.tagPushArgs);
		tagPushed = true;
	} catch (error) {
		const currentHead = safeGitOutput(["rev-parse", "HEAD"]);
		if (currentHead === preconditions.initialHead) {
			try {
				rollbackReleasePreparation({ buildArtifactsTouched, snapshots });
				console.error(
					buildArtifactsTouched
						? "Restored the three release files and removed aborted build output because no release commit was created."
						: "Restored the three release files because no release commit was created.",
				);
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					"Release failed and pre-commit rollback could not be completed. Inspect the release files and ignored build output.",
				);
			}
		} else {
			printRecovery({
				currentHead,
				initialHead: preconditions.initialHead,
				mainPushed,
				plan,
				tagPushed,
			});
		}
		throw error;
	}

	console.log(
		`\n=== Pushed source tag ${plan.tag}; publication is not complete until the Release workflow starts and passes ===`,
	);
	return version;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		await releaseMain();
	} catch (error) {
		console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
