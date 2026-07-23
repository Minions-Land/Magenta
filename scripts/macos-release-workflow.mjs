#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	MACOS_SIGNING_RECEIPT_ASSET_NAME,
	verifyPublishedMacosSigningReceipt,
} from "./macos-release-bundle-contract.mjs";
import {
	captureAppleSigningCredentials,
	executeMacosReleaseSigning,
	MACOS_CLIPBOARD_RESOURCE_PATH,
	MACOS_EMBEDDED_PAYLOADS,
	MACOS_OUTER_BINARIES,
	sha256File,
	verifyInitialReleaseBundle,
} from "./macos-release-signing.mjs";
import { normalizeAppleTeamId, readMacosReleaseTrust } from "./macos-release-trust.mjs";

const RELEASE_ARCHIVE_NAME = "magenta-resources-universal.tar.gz";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const OUTER_REBUILD_TIMEOUT_MS = 90 * 60 * 1000;

function runExternalCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		maxBuffer: 16 * 1024 * 1024,
		stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
		timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
	});
	if (result.error || result.status !== 0) {
		const detail = `${result.stderr ?? ""}`.trim();
		throw new Error(`${options.label ?? command} failed${detail ? `: ${detail}` : ""}.`);
	}
	return result;
}

function assertEmptyDirectory(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (readdirSync(path).length !== 0) throw new Error(`Resource staging directory is not empty: ${path}`);
}

async function loadReleaseSupport(workspaceRoot) {
	const modulePath = join(
		resolve(workspaceRoot),
		"pi/coding-agent/dist/utils/github-release-update-support.js",
	);
	return import(pathToFileURL(modulePath).href);
}

export async function prepareResourceStage({
	expectedVersion,
	releaseDir,
	releaseSupport,
	resourceRoot,
	runCommand = runExternalCommand,
	workspaceRoot,
}) {
	if (!VERSION_PATTERN.test(expectedVersion)) throw new Error(`Invalid expected release version: ${expectedVersion}`);
	const support = releaseSupport ?? (await loadReleaseSupport(workspaceRoot));
	const archivePath = join(resolve(releaseDir), RELEASE_ARCHIVE_NAME);
	const topLevelNames = await support.inspectReleaseResourceArchive(archivePath);
	assertEmptyDirectory(resolve(resourceRoot));
	runCommand("tar", ["-xzf", archivePath, "-C", resolve(resourceRoot)], {
		label: "Validated resource archive extraction",
	});
	await support.validateExtractedReleaseResources(resolve(resourceRoot), topLevelNames, expectedVersion);
	return { releaseSupport: support, topLevelNames };
}

export function createWorkflowSigningAdapters({
	expectedVersion,
	releaseSupport,
	resourceRoot,
	runCommand = runExternalCommand,
	topLevelNames,
	workspaceRoot,
}) {
	const root = resolve(workspaceRoot);
	const extractedRoot = resolve(resourceRoot);
	return {
		rebuildOuterBinaries: async ({ embeddedPayloads, outerBinaries }) => {
			const signedPayloadHashes = Object.fromEntries(
				embeddedPayloads.map((payload) => [payload.relativePath, payload.afterSha256]),
			);
			const provenPayloadHashes = new Map();
			const provenArchitectures = new Set();
			runCommand("npm", ["run", "build:release-all"], {
				cwd: join(root, "pi/coding-agent"),
				inherit: true,
				label: "Bun outer executable rebuild",
				timeout: OUTER_REBUILD_TIMEOUT_MS,
			});
			for (const outer of outerBinaries) {
				if (provenArchitectures.has(outer.architecture)) {
					throw new Error(`Outer rebuild contains duplicate architecture output: ${outer.architecture}.`);
				}
				provenArchitectures.add(outer.architecture);
				const rebuilt = join(root, "pi/coding-agent/dist/release", outer.assetName);
				copyFileSync(rebuilt, outer.path);
				const architecturePayloads = embeddedPayloads.filter(
					(payload) => payload.architecture === outer.architecture,
				);
				const kinds = architecturePayloads.map((payload) => payload.kind).sort();
				if (JSON.stringify(kinds) !== JSON.stringify(["fd", "process-tools", "rg"])) {
					throw new Error(`Outer rebuild helper plan is incomplete for ${outer.architecture}.`);
				}
				const outerBytes = readFileSync(outer.path);
				for (const payload of architecturePayloads) {
					if (sha256File(payload.path) !== signedPayloadHashes[payload.relativePath]) {
						throw new Error(`Outer rebuild changed signed embedded payload: ${payload.relativePath}`);
					}
					const signedBytes = readFileSync(payload.path);
					if (signedBytes.length === 0 || outerBytes.indexOf(signedBytes) === -1) {
						throw new Error(
							`Rebuilt ${outer.assetName} does not contain signed embedded payload bytes: ${payload.relativePath}`,
						);
					}
					provenPayloadHashes.set(payload.relativePath, signedPayloadHashes[payload.relativePath]);
				}
			}
			if (provenPayloadHashes.size !== embeddedPayloads.length) {
				throw new Error("Outer rebuild proof does not cover every signed embedded payload.");
			}
			return {
				embeddedPayloadSha256: Object.fromEntries(provenPayloadHashes),
			};
		},
		repackResourceArchive: async ({ clipboard, resourceArchivePath }) => {
			if (clipboard.relativePath !== MACOS_CLIPBOARD_RESOURCE_PATH) {
				throw new Error("Signed clipboard path does not match the resource archive contract.");
			}
			if (sha256File(clipboard.path) !== clipboard.afterSha256) {
				throw new Error("Signed clipboard changed before resource archive repack.");
			}
			runCommand("tar", ["-czf", resourceArchivePath, ...topLevelNames], {
				cwd: extractedRoot,
				env: { ...process.env, COPYFILE_DISABLE: "1" },
				label: "Signed resource archive repack",
			});
			const repackedTopLevelNames = await releaseSupport.inspectReleaseResourceArchive(resourceArchivePath);
			if (JSON.stringify(repackedTopLevelNames) !== JSON.stringify(topLevelNames)) {
				throw new Error("Repacked resource archive changed its top-level contract.");
			}
			await releaseSupport.validateExtractedReleaseResources(extractedRoot, topLevelNames, expectedVersion);
			const proofRoot = mkdtempSync(join(tmpdir(), "magenta-resource-archive-proof-"));
			try {
				runCommand("tar", ["-xzf", resourceArchivePath, "-C", proofRoot, clipboard.relativePath], {
					label: "Signed clipboard archive proof extraction",
				});
				const archivedClipboardSha256 = sha256File(join(proofRoot, clipboard.relativePath));
				if (archivedClipboardSha256 !== clipboard.afterSha256) {
					throw new Error("Repacked resource archive does not contain the signed clipboard bytes.");
				}
				return {
					clipboardSha256: archivedClipboardSha256,
					resourceArchiveSha256: sha256File(resourceArchivePath),
				};
			} finally {
				rmSync(proofRoot, { force: true, recursive: true });
			}
		},
	};
}

function readSignedIdentifier(path, runCommand) {
	const result = runCommand("codesign", ["--display", "--verbose=4", path], {
		label: `Final identifier inspection for ${path}`,
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	const matches = [...output.matchAll(/^Identifier=(.+)$/gmu)].map((match) => match[1]);
	if (matches.length !== 1) throw new Error(`Final signed payload has no unique Identifier: ${path}`);
	return matches[0];
}

export function verifyFinalSignedIdentifiers({ embeddedRoot, releaseDir, resourceRoot, runCommand = runExternalCommand }) {
	for (const payload of MACOS_EMBEDDED_PAYLOADS) {
		const path = join(resolve(embeddedRoot), payload.relativePath);
		if (readSignedIdentifier(path, runCommand) !== payload.identifier) {
			throw new Error(`Final signed helper Identifier mismatch: ${payload.relativePath}`);
		}
	}
	const clipboardPath = join(resolve(resourceRoot), MACOS_CLIPBOARD_RESOURCE_PATH);
	if (readSignedIdentifier(clipboardPath, runCommand) !== "land.minions.magenta.clipboard") {
		throw new Error("Final signed clipboard Identifier mismatch.");
	}
	for (const outer of MACOS_OUTER_BINARIES) {
		const path = join(resolve(releaseDir), outer.assetName);
		if (readSignedIdentifier(path, runCommand) !== outer.identifier) {
			throw new Error(`Final signed outer Identifier mismatch: ${outer.assetName}`);
		}
	}
}

export async function runMacosReleaseWorkflow({
	entitlementsPath,
	expectedInitialManifestSha256,
	expectedSourceCommit,
	expectedTeamId,
	expectedVersion,
	receiptPath,
	releaseDir,
	resourceRoot,
	runCommand = runExternalCommand,
	workspaceRoot,
}) {
	const sourceTrust = readMacosReleaseTrust(join(resolve(workspaceRoot), "scripts/macos-release-trust.json"));
	// Capture and scrub before staging can invoke tar, and before any later
	// rebuild/signing/notarization child process inherits the environment.
	const credentials = captureAppleSigningCredentials(process.env, { expectedTeamId: sourceTrust.appleTeamId });
	const requestedTeamId = normalizeAppleTeamId(expectedTeamId, "Workflow Apple Team ID");
	if (requestedTeamId !== sourceTrust.appleTeamId) {
		throw new Error("Workflow Apple Team ID does not match the source-owned release trust configuration.");
	}
	const initialBundle = verifyInitialReleaseBundle({
		expectedManifestSha256: expectedInitialManifestSha256,
		releaseDir,
	});
	const normalizedSourceCommit = String(expectedSourceCommit ?? "").trim().toLowerCase();
	if (!SOURCE_COMMIT_PATTERN.test(normalizedSourceCommit)) throw new Error("Expected source commit is invalid.");
	if (initialBundle.sourceCommit !== normalizedSourceCommit) {
		throw new Error("Unsigned bundle SOURCE_COMMIT does not match the checked-out source tag.");
	}
	const { releaseSupport, topLevelNames } = await prepareResourceStage({
		expectedVersion,
		releaseDir,
		resourceRoot,
		runCommand,
		workspaceRoot,
	});
	const adapters = createWorkflowSigningAdapters({
		expectedVersion,
		releaseSupport,
		resourceRoot,
		runCommand,
		topLevelNames,
		workspaceRoot,
	});
	const embeddedRoot = join(resolve(workspaceRoot), "HarnessComponentProtocol/_magenta");
	const receipt = await executeMacosReleaseSigning({
		credentials,
		embeddedRoot,
		expectedInitialManifestSha256,
		expectedTeamId: sourceTrust.appleTeamId,
		outerEntitlementsPath: resolve(entitlementsPath),
		receiptPath: resolve(receiptPath),
		releaseDir: resolve(releaseDir),
		resourceRoot: resolve(resourceRoot),
		...adapters,
	});
	verifyFinalSignedIdentifiers({ embeddedRoot, releaseDir, resourceRoot, runCommand });
	const finalBundle = verifyInitialReleaseBundle({
		expectedManifestSha256: receipt.finalManifestSha256,
		releaseDir,
	});
	if (finalBundle.sourceCommit !== normalizedSourceCommit) {
		throw new Error("Final signed bundle SOURCE_COMMIT changed during signing.");
	}
	verifyPublishedMacosSigningReceipt({
		bundle: finalBundle,
		expectedTeamId: sourceTrust.appleTeamId,
		receiptPath: resolve(receiptPath),
	});
	const publishedReceiptPath = join(resolve(releaseDir), MACOS_SIGNING_RECEIPT_ASSET_NAME);
	copyFileSync(resolve(receiptPath), publishedReceiptPath);
	if (sha256File(publishedReceiptPath) !== sha256File(resolve(receiptPath))) {
		throw new Error("Published macOS signing receipt copy does not match the sealed receipt.");
	}
	return receipt;
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
		entitlementsPath: required("--entitlements"),
		expectedInitialManifestSha256: required("--expected-initial-manifest-sha256"),
		expectedSourceCommit: required("--expected-source-commit"),
		expectedTeamId: required("--expected-team-id"),
		expectedVersion: required("--expected-version"),
		receiptPath: required("--receipt-path"),
		releaseDir: required("--release-dir"),
		resourceRoot: required("--resource-root"),
		workspaceRoot: required("--workspace-root"),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runMacosReleaseWorkflow(parseArguments(process.argv.slice(2))).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
