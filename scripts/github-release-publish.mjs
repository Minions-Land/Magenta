#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getPublishedReleaseAssetNames,
	MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	MACOS_SIGNING_RECEIPT_ASSET_NAME,
	verifyInitialReleaseBundle,
	verifyPublishedMacosSigningReceipt,
} from "./macos-release-bundle-contract.mjs";
import { readMacosReleaseTrust } from "./macos-release-trust.mjs";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASE_TARGET_COMMITISH = "main";

function readRegularFileWithoutFollowing(path, label) {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
	const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
	const descriptor = openSync(path, constants.O_RDONLY | noFollow);
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error(`${label} changed while the publication snapshot was captured.`);
		}
		return readFileSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

export function materializePublicationSnapshot(releaseDir, expectedAssetNames) {
	const sourceRoot = resolve(releaseDir);
	const sourceStats = lstatSync(sourceRoot);
	if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
		throw new Error("Release directory must be a real directory before publication.");
	}
	const expectedNames = getPublishedReleaseAssetNames(expectedAssetNames).sort();
	const entries = readdirSync(sourceRoot, { withFileTypes: true });
	const actualNames = entries.map(({ name }) => name).sort();
	if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
		throw new Error("Release directory contains a non-file top-level entry.");
	}
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error("Release directory does not contain the exact regular-file publication contract.");
	}

	const snapshotRoot = mkdtempSync(join(tmpdir(), "magenta-release-publication-"));
	try {
		for (const name of expectedNames) {
			const bytes = readRegularFileWithoutFollowing(join(sourceRoot, name), `Release asset ${name}`);
			const destination = join(snapshotRoot, name);
			const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
			try {
				writeFileSync(descriptor, bytes);
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
		}
		return snapshotRoot;
	} catch (error) {
		rmSync(snapshotRoot, { force: true, recursive: true });
		throw error;
	}
}

function runGh(args) {
	const result = spawnSync("gh", args, {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`GitHub release command failed: ${(result.stderr ?? "").trim()}`);
	}
	return result.stdout ?? "";
}

function parseJson(content, label) {
	try {
		return JSON.parse(content);
	} catch {
		throw new Error(`${label} returned invalid JSON.`);
	}
}

export function createGitHubReleaseApi({ repository, run = runGh } = {}) {
	return {
		createDraft: async (tag) =>
			parseJson(
				run([
					"api",
					`repos/${repository}/releases`,
					"--method",
					"POST",
					"-f",
					`tag_name=${tag}`,
					"-f",
					`target_commitish=${RELEASE_TARGET_COMMITISH}`,
					"-f",
					`name=${tag}`,
					"-f",
					"body=Pending verification...",
					"-F",
					"draft=true",
					"-F",
					"prerelease=false",
				]),
				"GitHub draft creation",
			),
		getRelease: async (tag) => {
			const pages = parseJson(
				run(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
				"GitHub release list",
			);
			if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
				throw new Error("GitHub release list did not return paginated arrays.");
			}
			const matches = pages
				.flat()
				.filter((release) => release && typeof release === "object" && release.tag_name === tag);
			if (matches.length > 1) {
				throw new Error(`Multiple GitHub releases use tag ${tag}; refusing to choose one.`);
			}
			return matches[0];
		},
		publishDraft: async (releaseId, notes) =>
			parseJson(
				run([
					"api",
					`repos/${repository}/releases/${releaseId}`,
					"--method",
					"PATCH",
					"-f",
					`body=${notes}`,
					"-F",
					"draft=false",
					"-F",
					"prerelease=false",
				]),
				"GitHub release publication",
			),
		uploadAsset: async (tag, path) => {
			run(["release", "upload", tag, path, "--repo", repository]);
		},
	};
}

function expectedLocalAssets(bundle, receiptSnapshot, expectedAssetNames) {
	const snapshots = [
		bundle.manifestSnapshot,
		...expectedAssetNames.map((name) => bundle.assetSnapshots[name]),
		receiptSnapshot,
	];
	const expectedNames = getPublishedReleaseAssetNames(expectedAssetNames);
	if (
		snapshots.some((snapshot) => !snapshot) ||
		JSON.stringify(snapshots.map(({ name }) => name)) !== JSON.stringify(expectedNames)
	) {
		throw new Error("Verified release snapshot does not match the publication asset contract.");
	}
	return new Map(snapshots.map((snapshot) => [snapshot.name, snapshot]));
}

function inspectReleaseIdentity(release, tag) {
	if (!release || typeof release !== "object") throw new Error("GitHub release metadata is missing.");
	if (release.tag_name !== tag) throw new Error("GitHub release tag does not match the requested release.");
	if (!Number.isSafeInteger(release.id)) throw new Error("GitHub release has no numeric id.");
	if (release.prerelease !== false) throw new Error("GitHub release prerelease metadata does not match the release contract.");
	if (release.target_commitish !== RELEASE_TARGET_COMMITISH) {
		throw new Error("GitHub release target_commitish does not match the release contract.");
	}
	if (release.name !== tag) throw new Error("GitHub release name does not match the release contract.");
}

function inspectReleaseAssets(release, desired, tag, label) {
	inspectReleaseIdentity(release, tag);
	if (!Array.isArray(release.assets)) throw new Error(`${label} has no asset metadata.`);
	const seen = new Set();
	for (const asset of release.assets) {
		if (!asset || typeof asset.name !== "string" || seen.has(asset.name)) {
			throw new Error(`${label} contains duplicate or malformed asset metadata.`);
		}
		seen.add(asset.name);
		const local = desired.get(asset.name);
		if (!local) throw new Error(`${label} contains an unexpected asset: ${asset.name}`);
		if (asset.state !== "uploaded") throw new Error(`${label} asset is not fully uploaded: ${asset.name}`);
		if (asset.size !== local.size || asset.digest !== `sha256:${local.digest}`) {
			if (label === "GitHub draft") {
				throw new Error(`GitHub draft asset does not match the verified bundle: ${asset.name}`);
			}
			throw new Error(`Published GitHub release asset does not match the verified bundle: ${asset.name}`);
		}
	}
	return seen;
}

function inspectDraft(release, desired, tag, { allowEmptyDraft, requireComplete }) {
	if (release?.draft !== true) {
		inspectReleaseIdentity(release, tag);
		throw new Error(`Release ${tag} is already published; refusing to modify it.`);
	}
	const seen = inspectReleaseAssets(release, desired, tag, "GitHub draft");
	if (seen.size > 0 && !seen.has("SOURCE_COMMIT")) {
		throw new Error("Existing non-empty draft is not bound to SOURCE_COMMIT; refusing to resume it.");
	}
	if (seen.size === 0 && !allowEmptyDraft) {
		throw new Error("Pre-existing empty draft is not bound to SOURCE_COMMIT; refusing to claim it.");
	}
	if (requireComplete && seen.size !== desired.size) {
		throw new Error(`GitHub draft asset set is incomplete: expected ${desired.size}, got ${seen.size}.`);
	}
	return seen;
}

function inspectPublishedRelease(release, desired, tag, expectedReleaseId) {
	inspectReleaseIdentity(release, tag);
	if (release.draft !== false || release.id !== expectedReleaseId) {
		throw new Error("Published GitHub release identity changed during final confirmation.");
	}
	const seen = inspectReleaseAssets(release, desired, tag, "Published GitHub release");
	if (seen.size !== desired.size) {
		throw new Error(`Published GitHub release asset set is incomplete: expected ${desired.size}, got ${seen.size}.`);
	}
}

export async function publishVerifiedRelease({
	api,
	expectedAssetNames = MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	expectedManifestSha256,
	expectedSourceCommit,
	expectedTeamId,
	notes,
	releaseDir,
	repository,
	sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
	tag,
}) {
	if (!REPOSITORY_PATTERN.test(repository)) throw new Error(`Invalid release repository: ${repository}`);
	if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
	if (typeof notes !== "string" || !notes.trim()) throw new Error("Release notes must not be empty.");
	const snapshotReleaseDir = materializePublicationSnapshot(releaseDir, expectedAssetNames);
	try {
		const bundle = verifyInitialReleaseBundle({
			allowedUnchecksummedAssets: [MACOS_SIGNING_RECEIPT_ASSET_NAME],
			expectedAssetNames,
			expectedManifestSha256,
			releaseDir: snapshotReleaseDir,
		});
		if (bundle.sourceCommit !== String(expectedSourceCommit).trim().toLowerCase()) {
			throw new Error("Verified release bundle does not match the checked-out source commit.");
		}
		const trustedTeamId = expectedTeamId ?? readMacosReleaseTrust().appleTeamId;
		const receiptVerification = verifyPublishedMacosSigningReceipt({
			bundle,
			expectedAssetNames,
			expectedTeamId: trustedTeamId,
			receiptPath: join(snapshotReleaseDir, MACOS_SIGNING_RECEIPT_ASSET_NAME),
		});
		const desired = expectedLocalAssets(bundle, receiptVerification.receiptSnapshot, expectedAssetNames);
		const github = api ?? createGitHubReleaseApi({ repository });
		let release = await github.getRelease(tag);
		const createdByThisRun = release === undefined;
		if (createdByThisRun) release = await github.createDraft(tag);
		const existing = inspectDraft(release, desired, tag, {
			allowEmptyDraft: createdByThisRun,
			requireComplete: false,
		});
		const uploadOrder = ["SOURCE_COMMIT", ...[...desired.keys()].filter((name) => name !== "SOURCE_COMMIT")];
		for (const name of uploadOrder) {
			const asset = desired.get(name);
			if (!existing.has(name)) await github.uploadAsset(tag, asset.path);
		}

		let exactDraft;
		for (let attempt = 0; attempt < 10; attempt++) {
			exactDraft = await github.getRelease(tag);
			try {
				inspectDraft(exactDraft, desired, tag, { allowEmptyDraft: false, requireComplete: true });
				break;
			} catch (error) {
				if (attempt === 9) throw error;
				await sleep(1000);
			}
		}
		const published = await github.publishDraft(exactDraft.id, notes);
		inspectReleaseIdentity(published, tag);
		if (published.draft !== false || published.id !== exactDraft.id) {
			throw new Error("GitHub did not confirm publication of the exact release tag.");
		}
		const confirmed = await github.getRelease(tag);
		inspectPublishedRelease(confirmed, desired, tag, exactDraft.id);
		return confirmed;
	} finally {
		rmSync(snapshotReleaseDir, { force: true, recursive: true });
	}
}

function parseArguments(args) {
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
			throw new Error(`Invalid or duplicate argument: ${flag ?? "(missing)"}`);
		}
		values.set(flag, value);
	}
	const required = (flag) => {
		const value = values.get(flag);
		if (!value) throw new Error(`Missing required argument: ${flag}`);
		return value;
	};
	return {
		expectedManifestSha256: required("--expected-manifest-sha256"),
		expectedSourceCommit: required("--expected-source-commit"),
		notes: readFileSync(required("--notes-file"), "utf8"),
		releaseDir: required("--release-dir"),
		repository: required("--repository"),
		tag: required("--tag"),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	publishVerifiedRelease(parseArguments(process.argv.slice(2)))
		.then((release) => process.stdout.write(`Published ${release.tag_name}.\n`))
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}
