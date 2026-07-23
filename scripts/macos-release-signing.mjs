#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertImmutableReleaseAssets,
	assertRegularFile,
	MACOS_EMBEDDED_PAYLOADS,
	MACOS_MUTABLE_RELEASE_ASSET_NAMES,
	MACOS_OUTER_BINARIES,
	MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	normalizeExpectedAssetNames,
	normalizeSha256,
	parseReleaseChecksumManifest,
	resolveContainedPath,
	sha256File,
	verifyInitialReleaseBundle,
	writeFileAtomically,
	writeFinalChecksumManifest,
} from "./macos-release-bundle-contract.mjs";
import {
	MACOS_SIGNING_ENV_KEYS,
	captureAppleSigningCredentials,
	readAppleSigningCredentials,
	withEphemeralAppleCredentials,
} from "./macos-signing-credentials.mjs";
import { normalizeAppleTeamId } from "./macos-release-trust.mjs";

export {
	MACOS_EMBEDDED_PAYLOADS,
	MACOS_MUTABLE_RELEASE_ASSET_NAMES,
	MACOS_OUTER_BINARIES,
	MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	MACOS_SIGNING_ENV_KEYS,
	parseReleaseChecksumManifest,
	captureAppleSigningCredentials,
	readAppleSigningCredentials,
	sha256File,
	verifyInitialReleaseBundle,
	withEphemeralAppleCredentials,
};

export const MACOS_CLIPBOARD_RESOURCE_PATH =
	"runtime/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node";

const NOTARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RECEIPT_SCHEMA = "magenta.macos-signing-receipt.v1";

function sha256Bytes(content) {
	return createHash("sha256").update(content).digest("hex");
}

function runExternalCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		throw new Error(`${options.label ?? command} failed.`);
	}
	return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function commandOutput(result) {
	return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

function runChecked(runCommand, command, args, options = {}) {
	const result = runCommand(command, args, options);
	if (result?.status !== undefined && result.status !== 0) {
		throw new Error(`${options.label ?? command} failed.`);
	}
	return result ?? { status: 0, stderr: "", stdout: "" };
}

function expectedLipoArchitecture(architecture) {
	return architecture === "x64" ? "x86_64" : architecture;
}

function verifyArchitectures({ path, architectures, runCommand }) {
	const result = runChecked(runCommand, "lipo", ["-archs", path], { label: `Architecture check for ${basename(path)}` });
	const actual = new Set(String(result.stdout ?? "").trim().split(/\s+/u).filter(Boolean));
	const expected = new Set(architectures.map(expectedLipoArchitecture));
	if (actual.size !== expected.size || [...expected].some((architecture) => !actual.has(architecture))) {
		throw new Error(
			`${basename(path)} architecture mismatch: expected ${[...expected].join(" ")}, got ${[...actual].join(" ")}.`,
		);
	}
}

function parseCodeSignature(output, expectedTeamId) {
	if (!/^Authority=Developer ID Application:/mu.test(output)) {
		throw new Error("Signed payload does not have a Developer ID Application authority.");
	}
	const team = /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(output)?.[1];
	if (team !== expectedTeamId) throw new Error(`Signed payload TeamIdentifier mismatch: ${team ?? "missing"}.`);
	if (/^Signature=adhoc$/mu.test(output) || /flags=.*\badhoc\b/iu.test(output)) {
		throw new Error("Signed payload still has an ad-hoc signature.");
	}
	if (!/flags=.*\bruntime\b/iu.test(output)) throw new Error("Signed payload does not enable hardened runtime.");
	if (!/^Timestamp=\S.+$/mu.test(output)) throw new Error("Signed payload has no secure timestamp.");
	return {
		cdHash: /^CDHash=([0-9a-f]+)$/imu.exec(output)?.[1]?.toLowerCase(),
		identifier: /^Identifier=(.+)$/mu.exec(output)?.[1],
		teamId: team,
	};
}

function assertEntitlementsFile(path) {
	assertRegularFile(path, "Outer executable entitlements");
	const content = readFileSync(path, "utf8");
	if (content.includes("com.apple.security.get-task-allow")) {
		throw new Error("Release entitlements must not enable get-task-allow.");
	}
}

function signPayload({
	architectures,
	credentials,
	entitlementsPath,
	identifier,
	keychainPath,
	path,
	runCommand,
}) {
	assertRegularFile(path, `Mach-O payload ${basename(path)}`);
	verifyArchitectures({ architectures, path, runCommand });
	const beforeSha256 = sha256File(path);
	const args = [
		"--force",
		"--sign",
		credentials.identity,
		"--keychain",
		keychainPath,
		"--identifier",
		identifier,
		"--options",
		"runtime",
		"--timestamp",
	];
	if (entitlementsPath) args.push("--entitlements", entitlementsPath);
	args.push(path);
	runChecked(runCommand, "codesign", args, { label: `Developer ID signing for ${basename(path)}` });
	runChecked(
		runCommand,
		"codesign",
		[
			"--verify",
			"--strict",
			"--verbose=2",
			"--test-requirement",
			"=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
			path,
		],
		{ label: `Developer ID verification for ${basename(path)}` },
	);
	const display = runChecked(runCommand, "codesign", ["--display", "--verbose=4", path], {
		label: `Code-signature inspection for ${basename(path)}`,
	});
	const signature = parseCodeSignature(commandOutput(display), credentials.teamId);
	if (signature.identifier !== identifier) {
		throw new Error(
			`Signed payload Identifier mismatch: expected ${identifier}, got ${signature.identifier ?? "missing"}.`,
		);
	}
	const afterSha256 = sha256File(path);
	if (afterSha256 === beforeSha256) throw new Error(`Signing did not change ${basename(path)}.`);
	return {
		afterSha256,
		architectures,
		beforeSha256,
		certificateSha256: credentials.certificateSha256,
		path,
		...signature,
	};
}

function rewriteEmbeddedChecksumReceipts(embeddedRoot) {
	const receipts = [];
	for (const kind of ["process-tools", "fd", "rg"]) {
		const directory = resolveContainedPath(embeddedRoot, `${kind}/prebuilt`, "Embedded payload directory");
		const receiptPath = join(directory, "SHA256SUMS");
		assertRegularFile(receiptPath, `${kind} checksum receipt`);
		const original = parseReleaseChecksumManifest(readFileSync(receiptPath, "utf8"));
		const lines = [];
		for (const name of original.keys()) {
			const payloadPath = resolveContainedPath(directory, name, `${kind} payload`);
			assertRegularFile(payloadPath, `${kind} payload ${name}`);
			lines.push(`${sha256File(payloadPath)}  ${name}`);
		}
		writeFileAtomically(receiptPath, `${lines.join("\n")}\n`, 0o644);
		receipts.push({ kind, path: receiptPath, sha256: sha256File(receiptPath) });
	}
	return receipts;
}

function verifyEmbeddedChecksumReceipts(embeddedRoot) {
	const receipts = [];
	for (const kind of ["process-tools", "fd", "rg"]) {
		const directory = resolveContainedPath(embeddedRoot, `${kind}/prebuilt`, "Embedded payload directory");
		const receiptPath = join(directory, "SHA256SUMS");
		assertRegularFile(receiptPath, `${kind} checksum receipt`);
		const checksums = parseReleaseChecksumManifest(readFileSync(receiptPath, "utf8"));
		for (const [name, expected] of checksums) {
			const payloadPath = resolveContainedPath(directory, name, `${kind} payload`);
			assertRegularFile(payloadPath, `${kind} payload ${name}`);
			const actual = sha256File(payloadPath);
			if (actual !== expected) throw new Error(`${kind} embedded payload does not match its tracked receipt: ${name}.`);
		}
		receipts.push({ kind, path: receiptPath, sha256: sha256File(receiptPath) });
	}
	return receipts;
}

function normalizeHashProof(proof, label) {
	if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error(`${label} is missing.`);
	return Object.fromEntries(
		Object.entries(proof)
			.map(([path, hash]) => [path, normalizeSha256(hash, `${label} entry ${path}`)])
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

function assertHashProof(expectedRecords, proof, label) {
	const normalized = normalizeHashProof(proof, label);
	const expected = Object.fromEntries(
		expectedRecords
			.map((record) => [record.relativePath, record.afterSha256])
			.sort(([left], [right]) => left.localeCompare(right)),
	);
	if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
		throw new Error(`${label} does not prove that rebuilt artifacts contain the signed payload bytes.`);
	}
}

function buildNotaryArchive({ architecture, clipboardPath, embeddedRecords, outerPath, temporaryDirectory, runCommand }) {
	const stage = join(temporaryDirectory, `notary-${architecture}`);
	const archive = join(temporaryDirectory, `notary-${architecture}.zip`);
	mkdirSync(stage, { recursive: true });
	copyFileSync(outerPath, join(stage, basename(outerPath)));
	copyFileSync(clipboardPath, join(stage, basename(clipboardPath)));
	for (const record of embeddedRecords.filter((entry) => entry.architecture === architecture)) {
		copyFileSync(record.path, join(stage, `${record.kind}-${architecture}`));
	}
	runChecked(runCommand, "ditto", ["-c", "-k", "--keepParent", stage, archive], {
		label: `Notarization archive creation for ${architecture}`,
	});
	assertRegularFile(archive, `Notarization archive for ${architecture}`);
	return archive;
}

function notarizeArchive({ architecture, archive, credentials, notaryKeyPath, runCommand }) {
	const submit = runChecked(
		runCommand,
		"xcrun",
		[
			"notarytool",
			"submit",
			archive,
			"--key",
			notaryKeyPath,
			"--key-id",
			credentials.notaryKeyId,
			"--issuer",
			credentials.notaryIssuerId,
			"--wait",
			"--timeout",
			"45m",
			"--output-format",
			"json",
			"--no-progress",
		],
		{ label: `Apple notarization submission for ${architecture}` },
	);
	let receipt;
	try {
		receipt = JSON.parse(String(submit.stdout ?? ""));
	} catch {
		throw new Error(`Apple notarization returned invalid JSON for ${architecture}.`);
	}
	if (receipt.status !== "Accepted" || !NOTARY_ID_PATTERN.test(receipt.id ?? "")) {
		throw new Error(`Apple notarization was not accepted for ${architecture}.`);
	}
	const log = runChecked(
		runCommand,
		"xcrun",
		[
			"notarytool",
			"log",
			receipt.id,
			"--key",
			notaryKeyPath,
			"--key-id",
			credentials.notaryKeyId,
			"--issuer",
			credentials.notaryIssuerId,
			"--output-format",
			"json",
		],
		{ label: `Apple notarization log retrieval for ${architecture}` },
	);
	return {
		architecture,
		id: receipt.id,
		logSha256: sha256Bytes(String(log.stdout ?? "")),
		status: receipt.status,
	};
}

function verifyOnlineNotarization({ path, runCommand }) {
	runChecked(
		runCommand,
		"codesign",
		[
			"--verify",
			"--strict",
			"--check-notarization",
			"--verbose=2",
			"--test-requirement",
			"=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
			path,
		],
		{ label: `Online notarization verification for ${basename(path)}` },
	);
}

function verifyFinalSignedPayload({ credentials, payload, runCommand }) {
	if (sha256File(payload.path) !== payload.afterSha256) {
		throw new Error(`Signed payload changed after signing: ${basename(payload.path)}.`);
	}
	verifyOnlineNotarization({ path: payload.path, runCommand });
	const display = runChecked(runCommand, "codesign", ["--display", "--verbose=4", payload.path], {
		label: `Final code-signature inspection for ${basename(payload.path)}`,
	});
	const signature = parseCodeSignature(commandOutput(display), credentials.teamId);
	if (signature.identifier !== payload.identifier) {
		throw new Error(
			`Final signed payload Identifier mismatch: expected ${payload.identifier}, got ${signature.identifier ?? "missing"}.`,
		);
	}
}

function resolveSigningPlan({ embeddedRoot, releaseDir, resourceRoot }) {
	const embeddedPayloads = MACOS_EMBEDDED_PAYLOADS.map((payload) => ({
		...payload,
		path: resolveContainedPath(embeddedRoot, payload.relativePath, "Embedded Mach-O payload"),
	}));
	const outerBinaries = MACOS_OUTER_BINARIES.map((binary) => ({
		...binary,
		path: resolveContainedPath(releaseDir, binary.assetName, "Outer macOS binary"),
	}));
	return {
		clipboard: {
			architectures: ["arm64", "x64"],
			identifier: "land.minions.magenta.clipboard",
			path: resolveContainedPath(resourceRoot, MACOS_CLIPBOARD_RESOURCE_PATH, "Clipboard Mach-O resource"),
			relativePath: MACOS_CLIPBOARD_RESOURCE_PATH,
		},
		embeddedPayloads,
		outerBinaries,
	};
}

export function createMacosSigningCommandPlan({ embeddedRoot, releaseDir, resourceRoot }) {
	const plan = resolveSigningPlan({ embeddedRoot, releaseDir, resourceRoot });
	return {
		order: [
			...plan.embeddedPayloads.map((payload) => `sign:${payload.relativePath}`),
			"rebuild:outer-binaries",
			`sign:${plan.clipboard.relativePath}`,
			"repack:resource-archive",
			...plan.outerBinaries.map((binary) => `sign:${binary.assetName}`),
			"notarize:arm64",
			"notarize:x64",
			"write:SHA256SUMS",
			"write:signing-receipt",
		],
		payloads: {
			clipboard: plan.clipboard.path,
			embedded: plan.embeddedPayloads.map(({ architecture, kind, path }) => ({ architecture, kind, path })),
			outer: plan.outerBinaries.map(({ architecture, assetName, path }) => ({ architecture, assetName, path })),
		},
	};
}

/**
 * Execute the signing contract in an ephemeral checkout/workspace.
 *
 * `rebuildOuterBinaries` must rebuild both Bun executables after the six
 * embedded helpers are signed and return `{ embeddedPayloadSha256 }`, keyed by
 * the relative paths in MACOS_EMBEDDED_PAYLOADS. `repackResourceArchive` must
 * repack the resource tar after the clipboard addon is signed and return
 * `{ clipboardSha256, resourceArchiveSha256 }`. These proofs prevent workflow
 * wiring from silently publishing stale outer binaries or a stale resource
 * archive.
 */
export async function executeMacosReleaseSigning({
	credentials,
	embeddedRoot,
	expectedAssetNames = MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	expectedInitialManifestSha256,
	expectedTeamId,
	now = () => new Date(),
	outerEntitlementsPath,
	rebuildOuterBinaries,
	receiptPath,
	releaseDir,
	repackResourceArchive,
	resourceRoot,
	runCommand = runExternalCommand,
	temporaryParent = tmpdir(),
}) {
	if (typeof rebuildOuterBinaries !== "function") throw new Error("rebuildOuterBinaries callback is required.");
	if (typeof repackResourceArchive !== "function") throw new Error("repackResourceArchive callback is required.");
	const trustedTeamId = normalizeAppleTeamId(expectedTeamId, "Expected source-owned Apple Team ID");
	if (credentials?.teamId !== trustedTeamId) {
		throw new Error("Signing credentials do not match the source-owned Apple Team ID.");
	}
	const receiptRelativeToRelease = relative(resolve(releaseDir), resolve(receiptPath));
	if (!receiptRelativeToRelease.split(/[\\/]/u).includes("..")) {
		throw new Error("Signing receipt must be written outside the checksummed release asset directory.");
	}
	assertEntitlementsFile(outerEntitlementsPath);
	const initialBundle = verifyInitialReleaseBundle({
		expectedAssetNames,
		expectedManifestSha256: expectedInitialManifestSha256,
		releaseDir,
	});
	const plan = resolveSigningPlan({ embeddedRoot, releaseDir, resourceRoot });
	const initialEmbeddedChecksumReceipts = verifyEmbeddedChecksumReceipts(embeddedRoot);

	return withEphemeralAppleCredentials(
		credentials,
		async ({ keychainPath, notaryKeyPath, temporaryDirectory }) => {
			const embeddedRecords = [];
			for (const payload of plan.embeddedPayloads) {
				const signed = signPayload({
					architectures: [payload.architecture],
					credentials,
					identifier: payload.identifier,
					keychainPath,
					path: payload.path,
					runCommand,
				});
				embeddedRecords.push({ ...payload, ...signed });
			}
			const embeddedChecksumReceipts = rewriteEmbeddedChecksumReceipts(embeddedRoot);

			const rebuildProof = await rebuildOuterBinaries({
				embeddedPayloads: embeddedRecords.map(({ afterSha256, architecture, kind, path, relativePath }) => ({
					afterSha256,
					architecture,
					kind,
					path,
					relativePath,
				})),
				outerBinaries: plan.outerBinaries,
			});
			assertHashProof(embeddedRecords, rebuildProof?.embeddedPayloadSha256, "Outer rebuild proof");
			for (const record of embeddedRecords) {
				if (sha256File(record.path) !== record.afterSha256) {
					throw new Error(`Outer rebuild mutated signed embedded payload ${record.relativePath}.`);
				}
			}

			const clipboardRecord = {
				...plan.clipboard,
				...signPayload({
					architectures: plan.clipboard.architectures,
					credentials,
					identifier: plan.clipboard.identifier,
					keychainPath,
					path: plan.clipboard.path,
					runCommand,
				}),
			};
			const resourceArchivePath = join(resolve(releaseDir), "magenta-resources-universal.tar.gz");
			const repackProof = await repackResourceArchive({
				clipboard: {
					afterSha256: clipboardRecord.afterSha256,
					path: clipboardRecord.path,
					relativePath: clipboardRecord.relativePath,
				},
				resourceArchivePath,
				resourceRoot: resolve(resourceRoot),
			});
			if (
				normalizeSha256(repackProof?.clipboardSha256, "Resource repack proof") !== clipboardRecord.afterSha256
			) {
				throw new Error("Resource repack proof does not cover the signed clipboard payload.");
			}
			if (
				normalizeSha256(repackProof?.resourceArchiveSha256, "Resource archive repack proof") !==
				sha256File(resourceArchivePath)
			) {
				throw new Error("Resource repack proof does not cover the final resource archive bytes.");
			}
			if (sha256File(clipboardRecord.path) !== clipboardRecord.afterSha256) {
				throw new Error("Resource repack mutated the signed clipboard payload.");
			}

			const outerRecords = [];
			for (const binary of plan.outerBinaries) {
				const signed = signPayload({
					architectures: [binary.architecture],
					credentials,
					entitlementsPath: outerEntitlementsPath,
					identifier: binary.identifier,
					keychainPath,
					path: binary.path,
					runCommand,
				});
				outerRecords.push({ ...binary, ...signed });
			}

			const notarization = [];
			for (const architecture of ["arm64", "x64"]) {
				const outer = outerRecords.find((entry) => entry.architecture === architecture);
				if (!outer) throw new Error(`Missing signed outer binary for ${architecture}.`);
				const archive = buildNotaryArchive({
					architecture,
					clipboardPath: clipboardRecord.path,
					embeddedRecords,
					outerPath: outer.path,
					runCommand,
					temporaryDirectory,
				});
				notarization.push(
					notarizeArchive({ architecture, archive, credentials, notaryKeyPath, runCommand }),
				);
			}

			for (const payload of [...embeddedRecords, clipboardRecord, ...outerRecords]) {
				verifyFinalSignedPayload({ credentials, payload, runCommand });
			}
			for (const outer of outerRecords) {
				runChecked(runCommand, "spctl", ["--assess", "--type", "execute", "--verbose=4", outer.path], {
					label: `Gatekeeper assessment for ${outer.assetName}`,
				});
			}

			assertImmutableReleaseAssets(initialBundle, releaseDir, expectedAssetNames);
			const finalManifest = writeFinalChecksumManifest(releaseDir, expectedAssetNames);
			const receipt = {
				assets: finalManifest.assetHashes,
				certificate: {
					sha256: credentials.certificateSha256,
					teamId: credentials.teamId,
				},
				createdAt: now().toISOString(),
				initialEmbeddedChecksumReceipts: Object.fromEntries(
					initialEmbeddedChecksumReceipts.map(({ kind, sha256 }) => [kind, sha256]),
				),
				embeddedChecksumReceipts: Object.fromEntries(
					embeddedChecksumReceipts.map(({ kind, sha256 }) => [kind, sha256]),
				),
				finalManifestSha256: finalManifest.manifestSha256,
				initialManifestSha256: initialBundle.initialManifestSha256,
				notarization,
				payloads: {
					clipboard: {
						afterSha256: clipboardRecord.afterSha256,
						beforeSha256: clipboardRecord.beforeSha256,
					},
					embedded: Object.fromEntries(
						embeddedRecords.map((record) => [record.relativePath, record.afterSha256]),
					),
					outer: Object.fromEntries(outerRecords.map((record) => [record.assetName, record.afterSha256])),
				},
				schema: RECEIPT_SCHEMA,
				sourceCommit: initialBundle.sourceCommit,
				expectedAssetNames: normalizeExpectedAssetNames(expectedAssetNames),
			};
			writeFileAtomically(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, 0o644);
			return receipt;
		},
		{ runCommand, temporaryParent },
	);
}

function parsePlanArguments(args) {
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? "(missing)"}`);
		values.set(key.slice(2), value);
	}
	const embeddedRoot = values.get("embedded-root");
	const releaseDir = values.get("release-dir");
	const resourceRoot = values.get("resource-root");
	if (!embeddedRoot || !releaseDir || !resourceRoot) {
		throw new Error(
			"Usage: macos-release-signing.mjs --embedded-root <dir> --release-dir <dir> --resource-root <dir>",
		);
	}
	return { embeddedRoot, releaseDir, resourceRoot };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const plan = createMacosSigningCommandPlan(parsePlanArguments(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
