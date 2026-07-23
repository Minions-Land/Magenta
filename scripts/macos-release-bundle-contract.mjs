import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const MACOS_RELEASE_ASSET_NAMES_V0_0_30 = Object.freeze([
	"magenta-macos-arm64",
	"magenta-macos-x64",
	"magenta-linux-x64",
	"magenta-windows-x64.exe",
	"magenta-resources-universal.tar.gz",
	"install.sh",
	"install.ps1",
	"SOURCE_COMMIT",
]);

export const MACOS_SIGNING_RECEIPT_ASSET_NAME = "macos-signing-receipt.json";

export function getPublishedReleaseAssetNames(expectedAssetNames = MACOS_RELEASE_ASSET_NAMES_V0_0_30) {
	return ["SHA256SUMS", ...expectedAssetNames, MACOS_SIGNING_RECEIPT_ASSET_NAME];
}

export const MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30 = Object.freeze(getPublishedReleaseAssetNames());

export const MACOS_EMBEDDED_PAYLOADS = Object.freeze([
	{
		architecture: "arm64",
		identifier: "land.minions.magenta.process-tools",
		kind: "process-tools",
		relativePath: "process-tools/prebuilt/magenta-process-tools-macos-arm64",
	},
	{
		architecture: "arm64",
		identifier: "land.minions.magenta.fd",
		kind: "fd",
		relativePath: "fd/prebuilt/fd-macos-arm64",
	},
	{
		architecture: "arm64",
		identifier: "land.minions.magenta.rg",
		kind: "rg",
		relativePath: "rg/prebuilt/rg-macos-arm64",
	},
	{
		architecture: "x64",
		identifier: "land.minions.magenta.process-tools",
		kind: "process-tools",
		relativePath: "process-tools/prebuilt/magenta-process-tools-macos-x64",
	},
	{
		architecture: "x64",
		identifier: "land.minions.magenta.fd",
		kind: "fd",
		relativePath: "fd/prebuilt/fd-macos-x64",
	},
	{
		architecture: "x64",
		identifier: "land.minions.magenta.rg",
		kind: "rg",
		relativePath: "rg/prebuilt/rg-macos-x64",
	},
]);

export const MACOS_OUTER_BINARIES = Object.freeze([
	{
		architecture: "arm64",
		assetName: "magenta-macos-arm64",
		identifier: "land.minions.magenta",
	},
	{
		architecture: "x64",
		assetName: "magenta-macos-x64",
		identifier: "land.minions.magenta",
	},
]);

export const MACOS_MUTABLE_RELEASE_ASSET_NAMES = new Set([
	"magenta-macos-arm64",
	"magenta-macos-x64",
	"magenta-resources-universal.tar.gz",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readRegularFileSnapshot(path, name, label) {
	assertRegularFile(path, label);
	const bytes = readFileSync(path);
	return {
		bytes,
		snapshot: Object.freeze({
			digest: createHash("sha256").update(bytes).digest("hex"),
			name,
			path,
			size: bytes.byteLength,
		}),
	};
}

export function normalizeSha256(value, label) {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a 64-character SHA-256 value.`);
	return normalized;
}

export function resolveContainedPath(root, relativePath, label) {
	if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
		throw new Error(`${label} is not a safe relative path: ${JSON.stringify(relativePath)}`);
	}
	const absoluteRoot = resolve(root);
	const path = resolve(absoluteRoot, relativePath);
	const fromRoot = relative(absoluteRoot, path);
	if (!fromRoot || fromRoot.split(/[\\/]/u).includes("..")) {
		throw new Error(`${label} escapes its root: ${JSON.stringify(relativePath)}`);
	}
	return path;
}

export function assertRegularFile(path, label) {
	if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

export function parseReleaseChecksumManifest(content) {
	const checksums = new Map();
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line) continue;
		const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
		if (!match) throw new Error(`Invalid SHA256SUMS line ${index + 1}.`);
		const [, hash, name] = match;
		if (checksums.has(name)) throw new Error(`Duplicate SHA256SUMS entry: ${name}`);
		checksums.set(name, hash);
	}
	if (checksums.size === 0) throw new Error("SHA256SUMS contains no entries.");
	return checksums;
}

export function normalizeExpectedAssetNames(expectedAssetNames) {
	if (!Array.isArray(expectedAssetNames) || expectedAssetNames.length === 0) {
		throw new Error("Expected release asset contract must be a non-empty array.");
	}
	const names = expectedAssetNames.map((name) => {
		if (typeof name !== "string" || !SAFE_ASSET_NAME_PATTERN.test(name) || name === "SHA256SUMS") {
			throw new Error(`Invalid expected release asset name: ${JSON.stringify(name)}`);
		}
		return name;
	});
	if (new Set(names).size !== names.length) throw new Error("Expected release asset contract contains duplicates.");
	for (const required of MACOS_MUTABLE_RELEASE_ASSET_NAMES) {
		if (!names.includes(required)) throw new Error(`Expected release asset contract is missing ${required}.`);
	}
	if (!names.includes("SOURCE_COMMIT")) throw new Error("Expected release asset contract is missing SOURCE_COMMIT.");
	return names;
}

export function verifyInitialReleaseBundle({
	releaseDir,
	expectedManifestSha256,
	expectedAssetNames = MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	allowedUnchecksummedAssets = [],
}) {
	const root = resolve(releaseDir);
	const manifestPath = join(root, "SHA256SUMS");
	const manifestFile = readRegularFileSnapshot(manifestPath, "SHA256SUMS", "Initial checksum manifest");
	const expectedManifest = normalizeSha256(expectedManifestSha256, "Initial manifest digest");
	const actualManifest = manifestFile.snapshot.digest;
	if (actualManifest !== expectedManifest) {
		throw new Error(`Initial checksum manifest digest mismatch: expected ${expectedManifest}, got ${actualManifest}.`);
	}

	const checksums = parseReleaseChecksumManifest(manifestFile.bytes.toString("utf8"));
	const expectedNames = [...normalizeExpectedAssetNames(expectedAssetNames)].sort();
	const actualNames = [...checksums.keys()].sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error(
			`Release checksum asset set mismatch. Expected ${expectedNames.join(", ")}; got ${actualNames.join(", ")}.`,
		);
	}

	const assetHashes = {};
	const assetSnapshots = {};
	let sourceCommitBytes;
	for (const [name, expectedHash] of checksums) {
		const path = resolveContainedPath(root, name, "Release asset");
		const file = readRegularFileSnapshot(path, name, `Release asset ${name}`);
		const actualHash = file.snapshot.digest;
		if (actualHash !== expectedHash) {
			throw new Error(`Initial checksum mismatch for ${name}: expected ${expectedHash}, got ${actualHash}.`);
		}
		assetHashes[name] = actualHash;
		assetSnapshots[name] = file.snapshot;
		if (name === "SOURCE_COMMIT") sourceCommitBytes = file.bytes;
	}

	const allowedUnchecksummed = new Set(
		allowedUnchecksummedAssets.map((name) => {
			if (typeof name !== "string" || !SAFE_ASSET_NAME_PATTERN.test(name) || name === "SHA256SUMS") {
				throw new Error(`Invalid unchecksummed release asset name: ${JSON.stringify(name)}`);
			}
			return name;
		}),
	);
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error(`Release directory contains a top-level symlink: ${entry.name}`);
		if (!entry.isFile()) throw new Error(`Release directory contains a non-file top-level entry: ${entry.name}`);
		if (entry.name !== "SHA256SUMS" && !checksums.has(entry.name) && !allowedUnchecksummed.has(entry.name)) {
			throw new Error(`Unexpected release asset outside SHA256SUMS: ${entry.name}`);
		}
	}

	const sourceCommit = sourceCommitBytes?.toString("utf8").trim().toLowerCase();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)) {
		throw new Error("SOURCE_COMMIT must contain one full Git object ID.");
	}
	return Object.freeze({
		assetHashes: Object.freeze(assetHashes),
		assetSnapshots: Object.freeze(assetSnapshots),
		initialManifestSha256: actualManifest,
		manifestSnapshot: manifestFile.snapshot,
		sourceCommit,
	});
}

function assertExactObjectKeys(value, expectedKeys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const keys = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`${label} has an unsupported schema.`);
}

function assertExactSha256Record(value, expectedKeys, label) {
	assertExactObjectKeys(value, expectedKeys, label);
	for (const key of expectedKeys) {
		if (typeof value[key] !== "string" || !SHA256_PATTERN.test(value[key])) {
			throw new Error(`${label} contains an invalid SHA-256 value: ${key}`);
		}
	}
}

export function verifyPublishedMacosSigningReceipt({
	bundle,
	expectedAssetNames = MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	expectedTeamId,
	receiptPath,
}) {
	const receiptFile = readRegularFileSnapshot(
		receiptPath,
		MACOS_SIGNING_RECEIPT_ASSET_NAME,
		"Published macOS signing receipt",
	);
	let receipt;
	try {
		receipt = JSON.parse(receiptFile.bytes.toString("utf8"));
	} catch {
		throw new Error("Published macOS signing receipt is not valid JSON.");
	}
	assertExactObjectKeys(
		receipt,
		[
			"assets",
			"certificate",
			"createdAt",
			"embeddedChecksumReceipts",
			"expectedAssetNames",
			"finalManifestSha256",
			"initialEmbeddedChecksumReceipts",
			"initialManifestSha256",
			"notarization",
			"payloads",
			"schema",
			"sourceCommit",
		],
		"Published macOS signing receipt",
	);
	if (receipt.schema !== "magenta.macos-signing-receipt.v1") {
		throw new Error("Published macOS signing receipt has an unsupported schema.");
	}
	if (receipt.sourceCommit !== bundle.sourceCommit) {
		throw new Error("Published macOS signing receipt SOURCE_COMMIT mismatch.");
	}
	if (receipt.finalManifestSha256 !== bundle.initialManifestSha256) {
		throw new Error("Published macOS signing receipt manifest mismatch.");
	}
	if (
		typeof receipt.initialManifestSha256 !== "string" ||
		!SHA256_PATTERN.test(receipt.initialManifestSha256) ||
		receipt.initialManifestSha256 === receipt.finalManifestSha256
	) {
		throw new Error("Published macOS signing receipt initial manifest evidence is invalid.");
	}
	const expectedNames = normalizeExpectedAssetNames(expectedAssetNames);
	if (JSON.stringify(receipt.expectedAssetNames) !== JSON.stringify(expectedNames)) {
		throw new Error("Published macOS signing receipt asset contract mismatch.");
	}
	assertExactObjectKeys(receipt.assets, expectedNames, "Published macOS signing receipt assets");
	for (const name of expectedNames) {
		if (receipt.assets[name] !== bundle.assetHashes[name]) {
			throw new Error(`Published macOS signing receipt asset hash mismatch: ${name}`);
		}
	}
	assertExactObjectKeys(receipt.certificate, ["sha256", "teamId"], "Published signing certificate");
	if (
		!/^[A-Z0-9]{10}$/u.test(expectedTeamId) ||
		!SHA256_PATTERN.test(receipt.certificate.sha256) ||
		receipt.certificate.teamId !== expectedTeamId
	) {
		throw new Error("Published macOS signing receipt certificate trust mismatch.");
	}
	const checksumReceiptKinds = ["fd", "process-tools", "rg"];
	assertExactSha256Record(
		receipt.initialEmbeddedChecksumReceipts,
		checksumReceiptKinds,
		"Published initial embedded checksum receipts",
	);
	assertExactSha256Record(
		receipt.embeddedChecksumReceipts,
		checksumReceiptKinds,
		"Published embedded checksum receipts",
	);
	for (const kind of checksumReceiptKinds) {
		if (receipt.initialEmbeddedChecksumReceipts[kind] === receipt.embeddedChecksumReceipts[kind]) {
			throw new Error(`Published embedded checksum receipt did not change after signing: ${kind}`);
		}
	}
	assertExactObjectKeys(receipt.payloads, ["clipboard", "embedded", "outer"], "Published signed payloads");
	assertExactSha256Record(
		receipt.payloads.clipboard,
		["afterSha256", "beforeSha256"],
		"Published signed clipboard payload",
	);
	if (receipt.payloads.clipboard.afterSha256 === receipt.payloads.clipboard.beforeSha256) {
		throw new Error("Published signed clipboard payload did not change during signing.");
	}
	const embeddedPayloadPaths = MACOS_EMBEDDED_PAYLOADS.map(({ relativePath }) => relativePath);
	assertExactSha256Record(receipt.payloads.embedded, embeddedPayloadPaths, "Published signed embedded payloads");
	const outerAssetNames = MACOS_OUTER_BINARIES.map(({ assetName }) => assetName);
	assertExactSha256Record(receipt.payloads.outer, outerAssetNames, "Published signed outer payloads");
	for (const name of outerAssetNames) {
		if (receipt.payloads.outer[name] !== bundle.assetHashes[name]) {
			throw new Error(`Published signed outer payload hash mismatch: ${name}`);
		}
	}
	if (!Array.isArray(receipt.notarization) || receipt.notarization.length !== 2) {
		throw new Error("Published macOS signing receipt must contain two notarizations.");
	}
	const notarizedArchitectures = new Set();
	for (const record of receipt.notarization) {
		assertExactObjectKeys(record, ["architecture", "id", "logSha256", "status"], "Notarization record");
		if (
			(record.architecture !== "arm64" && record.architecture !== "x64") ||
			notarizedArchitectures.has(record.architecture) ||
			record.status !== "Accepted" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(record.id) ||
			!SHA256_PATTERN.test(record.logSha256)
		) {
			throw new Error("Published macOS signing receipt contains invalid notarization evidence.");
		}
		notarizedArchitectures.add(record.architecture);
	}
	let normalizedCreatedAt;
	try {
		normalizedCreatedAt = new Date(receipt.createdAt).toISOString();
	} catch {
		normalizedCreatedAt = undefined;
	}
	if (typeof receipt.createdAt !== "string" || normalizedCreatedAt !== receipt.createdAt) {
		throw new Error("Published macOS signing receipt timestamp is invalid.");
	}
	return Object.freeze({ receipt, receiptSnapshot: receiptFile.snapshot });
}

export function assertImmutableReleaseAssets(initialBundle, releaseDir, expectedAssetNames) {
	for (const name of normalizeExpectedAssetNames(expectedAssetNames)) {
		if (MACOS_MUTABLE_RELEASE_ASSET_NAMES.has(name)) continue;
		const path = resolveContainedPath(releaseDir, name, "Immutable release asset");
		assertRegularFile(path, `Immutable release asset ${name}`);
		if (sha256File(path) !== initialBundle.assetHashes[name]) {
			throw new Error(`Signing changed immutable release asset ${name}.`);
		}
	}
}

export function writeFileAtomically(path, content, mode) {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	try {
		writeFileSync(temporaryPath, content, { mode });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function writeFinalChecksumManifest(releaseDir, expectedAssetNames) {
	const assetHashes = {};
	const lines = [];
	for (const name of normalizeExpectedAssetNames(expectedAssetNames)) {
		const path = resolveContainedPath(releaseDir, name, "Final release asset");
		assertRegularFile(path, `Final release asset ${name}`);
		const hash = sha256File(path);
		assetHashes[name] = hash;
		lines.push(`${hash}  ${name}`);
	}
	const manifestPath = join(resolve(releaseDir), "SHA256SUMS");
	writeFileAtomically(manifestPath, `${lines.join("\n")}\n`, 0o644);
	return { assetHashes, manifestPath, manifestSha256: sha256File(manifestPath) };
}
