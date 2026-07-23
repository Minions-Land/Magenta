import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MACOS_EMBEDDED_PAYLOADS,
	MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30,
	MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	MACOS_SIGNING_RECEIPT_ASSET_NAME,
	sha256File,
} from "./macos-release-bundle-contract.mjs";
import { createGitHubReleaseApi, publishVerifiedRelease } from "./github-release-publish.mjs";

const TAG = "v0.0.30";
const SOURCE_COMMIT = "a".repeat(40);
const TEAM_ID = "ABCDE12345";

function createBundle() {
	const root = mkdtempSync(join(tmpdir(), "magenta-github-release-"));
	for (const name of MACOS_RELEASE_ASSET_NAMES_V0_0_30) {
		writeFileSync(join(root, name), name === "SOURCE_COMMIT" ? `${SOURCE_COMMIT}\n` : `${name}\n`);
	}
	writeFileSync(
		join(root, "SHA256SUMS"),
		`${MACOS_RELEASE_ASSET_NAMES_V0_0_30.map((name) => `${sha256File(join(root, name))}  ${name}`).join("\n")}\n`,
	);
	const manifestSha256 = sha256File(join(root, "SHA256SUMS"));
	const embeddedPayloads = Object.fromEntries(
		MACOS_EMBEDDED_PAYLOADS.map(({ relativePath }, index) => [relativePath, String(index + 1).repeat(64)]),
	);
	const initialEmbeddedChecksumReceipts = {
		fd: "1".repeat(64),
		"process-tools": "2".repeat(64),
		rg: "3".repeat(64),
	};
	const embeddedChecksumReceipts = {
		fd: "4".repeat(64),
		"process-tools": "5".repeat(64),
		rg: "6".repeat(64),
	};
	writeFileSync(
		join(root, MACOS_SIGNING_RECEIPT_ASSET_NAME),
		`${JSON.stringify({
			assets: Object.fromEntries(
				MACOS_RELEASE_ASSET_NAMES_V0_0_30.map((name) => [name, sha256File(join(root, name))]),
			),
			certificate: { sha256: "b".repeat(64), teamId: TEAM_ID },
			createdAt: "2026-07-23T01:00:00.000Z",
				embeddedChecksumReceipts,
			expectedAssetNames: MACOS_RELEASE_ASSET_NAMES_V0_0_30,
			finalManifestSha256: manifestSha256,
				initialEmbeddedChecksumReceipts,
			initialManifestSha256: "c".repeat(64),
			notarization: [
				{
					architecture: "arm64",
					id: "11111111-1111-4111-8111-111111111111",
					logSha256: "d".repeat(64),
					status: "Accepted",
				},
				{
					architecture: "x64",
					id: "22222222-2222-4222-8222-222222222222",
					logSha256: "e".repeat(64),
					status: "Accepted",
				},
			],
				payloads: {
					clipboard: { afterSha256: "7".repeat(64), beforeSha256: "8".repeat(64) },
					embedded: embeddedPayloads,
					outer: {
						"magenta-macos-arm64": sha256File(join(root, "magenta-macos-arm64")),
						"magenta-macos-x64": sha256File(join(root, "magenta-macos-x64")),
					},
				},
			schema: "magenta.macos-signing-receipt.v1",
			sourceCommit: SOURCE_COMMIT,
		}, null, 2)}\n`,
	);
	return { manifestSha256, root };
}

function assetMetadata(path) {
	return {
		digest: `sha256:${sha256File(path)}`,
		name: path.split("/").at(-1),
		size: statSync(path).size,
		state: "uploaded",
	};
}

function releaseMetadata(overrides = {}) {
	return {
		assets: [],
		draft: true,
		id: 42,
		name: TAG,
		prerelease: false,
		tag_name: TAG,
		target_commitish: "main",
		...overrides,
	};
}

function createFakeApi(release) {
	let current = release;
	const calls = [];
	return {
		calls,
		createDraft: async (tag) => {
			calls.push(["create", tag]);
			current = releaseMetadata({ name: tag, tag_name: tag });
			return current;
		},
		getRelease: async () => current,
		publishDraft: async (id) => {
			calls.push(["publish", id]);
			current = { ...current, draft: false, prerelease: false };
			return current;
		},
		uploadAsset: async (_tag, path) => {
			calls.push(["upload", path.split("/").at(-1)]);
			current.assets.push(assetMetadata(path));
		},
	};
}

function publishOptions(bundle, api) {
	return {
		api,
		expectedManifestSha256: bundle.manifestSha256,
		expectedSourceCommit: SOURCE_COMMIT,
		expectedTeamId: TEAM_ID,
		notes: "Verified release notes\n",
		releaseDir: bundle.root,
		repository: "Minions-Land/Magenta-CLI",
		sleep: async () => undefined,
		tag: TAG,
	};
}

test("creates, fills, verifies, and publishes a new draft", async () => {
	const bundle = createBundle();
	const api = createFakeApi(undefined);
	try {
		await publishVerifiedRelease(publishOptions(bundle, api));
		assert.equal(MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30.length, 10);
		assert.equal(api.calls.filter(([kind]) => kind === "upload").length, 10);
		assert.deepEqual(api.calls.at(-1), ["publish", 42]);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("uploads the private immutable snapshot when source assets mutate after verification", async () => {
	const bundle = createBundle();
	const api = createFakeApi(undefined);
	const expected = new Map(
		MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30.map((name) => [name, assetMetadata(join(bundle.root, name))]),
	);
	const getRelease = api.getRelease;
	let mutated = false;
	api.getRelease = async (...args) => {
		if (!mutated) {
			mutated = true;
			for (const name of MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30) {
				writeFileSync(join(bundle.root, name), `tampered after verification:${name}\n`);
			}
		}
		return getRelease(...args);
	};
	try {
		const published = await publishVerifiedRelease(publishOptions(bundle, api));
		assert.equal(api.calls.filter(([kind]) => kind === "upload").length, 10);
		assert.equal(api.calls.some(([kind]) => kind === "publish"), true);
		assert.deepEqual(
			new Map(published.assets.map((asset) => [asset.name, asset])),
			expected,
		);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("re-fetches and rejects an exact asset change after GitHub publishes the draft", async () => {
	const bundle = createBundle();
	const api = createFakeApi(undefined);
	const getRelease = api.getRelease;
	let changedPublishedAsset = false;
	api.getRelease = async (...args) => {
		const release = await getRelease(...args);
		if (release?.draft === false && !changedPublishedAsset) {
			changedPublishedAsset = true;
			release.assets[0] = { ...release.assets[0], digest: `sha256:${"f".repeat(64)}` };
		}
		return release;
	};
	try {
		await assert.rejects(
			() => publishVerifiedRelease(publishOptions(bundle, api)),
			/Published GitHub release asset does not match the verified bundle/u,
		);
		assert.equal(api.calls.some(([kind]) => kind === "publish"), true);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("resumes an exact partial draft without replacing existing assets", async () => {
	const bundle = createBundle();
	const existingPath = join(bundle.root, "SOURCE_COMMIT");
	const api = createFakeApi(releaseMetadata({
		assets: [assetMetadata(existingPath)],
		id: 43,
	}));
	try {
		await publishVerifiedRelease(publishOptions(bundle, api));
		assert.equal(api.calls.filter(([kind]) => kind === "upload").length, 9);
		assert.equal(api.calls.some(([kind, name]) => kind === "upload" && name === "SOURCE_COMMIT"), false);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("fails closed for a mismatched draft asset", async () => {
	const bundle = createBundle();
	const mismatched = { ...assetMetadata(join(bundle.root, "SHA256SUMS")), digest: `sha256:${"f".repeat(64)}` };
	const api = createFakeApi(releaseMetadata({ assets: [mismatched], id: 44 }));
	try {
		await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), /does not match/u);
		assert.equal(api.calls.length, 0);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("fails closed before creating a draft when the durable signing receipt is tampered", async () => {
	const bundle = createBundle();
	const receiptPath = join(bundle.root, MACOS_SIGNING_RECEIPT_ASSET_NAME);
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	receipt.certificate.teamId = "ZZZZZ99999";
	writeFileSync(receiptPath, JSON.stringify(receipt));
	const api = createFakeApi(undefined);
	try {
		await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), /certificate trust mismatch/u);
		assert.equal(api.calls.length, 0);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("deeply validates every durable signing-receipt payload before creating a draft", async () => {
	const mutations = [
		{
			apply: (receipt) => {
				delete receipt.payloads.embedded[MACOS_EMBEDDED_PAYLOADS[0].relativePath];
			},
			pattern: /embedded payloads.*schema/u,
		},
		{
			apply: (receipt) => {
				receipt.payloads.outer["magenta-macos-arm64"] = "f".repeat(64);
			},
			pattern: /outer payload hash mismatch/u,
		},
		{
			apply: (receipt) => {
				receipt.embeddedChecksumReceipts.fd = receipt.initialEmbeddedChecksumReceipts.fd;
			},
			pattern: /did not change after signing/u,
		},
		{
			apply: (receipt) => {
				receipt.payloads.clipboard.afterSha256 = receipt.payloads.clipboard.beforeSha256;
			},
			pattern: /clipboard payload did not change/u,
		},
	];
	for (const mutation of mutations) {
		const bundle = createBundle();
		const receiptPath = join(bundle.root, MACOS_SIGNING_RECEIPT_ASSET_NAME);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		mutation.apply(receipt);
		writeFileSync(receiptPath, JSON.stringify(receipt));
		const api = createFakeApi(undefined);
		try {
			await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), mutation.pattern);
			assert.equal(api.calls.length, 0);
		} finally {
			rmSync(bundle.root, { recursive: true, force: true });
		}
	}
});

test("rejects non-file entries outside the exact ten-asset publication contract", async () => {
	const bundle = createBundle();
	const api = createFakeApi(undefined);
	mkdirSync(join(bundle.root, "unexpected-directory"));
	try {
		await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), /non-file top-level entry/u);
		assert.equal(api.calls.length, 0);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("does not resume a non-empty draft before SOURCE_COMMIT binds it", async () => {
	const bundle = createBundle();
	const api = createFakeApi(releaseMetadata({
		assets: [assetMetadata(join(bundle.root, "SHA256SUMS"))],
		id: 46,
	}));
	try {
		await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), /not bound to SOURCE_COMMIT/u);
		assert.equal(api.calls.length, 0);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("never treats an existing published release as a resumable draft", async () => {
	const bundle = createBundle();
	const api = createFakeApi(releaseMetadata({ draft: false, id: 45 }));
	try {
		await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), /already published/u);
		assert.equal(api.calls.length, 0);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("discovers drafts through the paginated release list", async () => {
	const draft = releaseMetadata({ id: 77 });
	const calls = [];
	const api = createGitHubReleaseApi({
		repository: "Minions-Land/Magenta-CLI",
		run: (args) => {
			calls.push(args);
			return JSON.stringify([
				[{ ...releaseMetadata({ id: 76 }), tag_name: "v0.0.29" }],
				[draft],
			]);
		},
	});
	assert.deepEqual(await api.getRelease(TAG), draft);
	assert.deepEqual(calls, [
		["api", "--paginate", "--slurp", "repos/Minions-Land/Magenta-CLI/releases?per_page=100"],
	]);
});

test("fails closed when paginated release discovery finds duplicate tags", async () => {
	const api = createGitHubReleaseApi({
		repository: "Minions-Land/Magenta-CLI",
		run: () => JSON.stringify([[releaseMetadata({ id: 80 })], [releaseMetadata({ id: 81 })]]),
	});
	await assert.rejects(() => api.getRelease(TAG), /Multiple GitHub releases use tag/u);
});

test("does not claim a pre-existing empty draft", async () => {
	const bundle = createBundle();
	const api = createFakeApi(releaseMetadata({ id: 82 }));
	try {
		await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), /Pre-existing empty draft/u);
		assert.equal(api.calls.length, 0);
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});

test("requires exact resumable draft metadata", async () => {
	const bundle = createBundle();
	const sourceAsset = assetMetadata(join(bundle.root, "SOURCE_COMMIT"));
	try {
		for (const [override, pattern] of [
			[{ prerelease: true }, /prerelease metadata/u],
			[{ target_commitish: "develop" }, /target_commitish/u],
			[{ name: "Magenta 0.0.30" }, /release name/u],
		]) {
			const api = createFakeApi(releaseMetadata({ assets: [sourceAsset], id: 83, ...override }));
			await assert.rejects(() => publishVerifiedRelease(publishOptions(bundle, api)), pattern);
			assert.equal(api.calls.length, 0);
		}
	} finally {
		rmSync(bundle.root, { recursive: true, force: true });
	}
});
