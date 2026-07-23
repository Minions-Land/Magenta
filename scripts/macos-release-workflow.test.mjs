import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	MACOS_CLIPBOARD_RESOURCE_PATH,
	MACOS_EMBEDDED_PAYLOADS,
	MACOS_OUTER_BINARIES,
	sha256File,
} from "./macos-release-signing.mjs";
import { createWorkflowSigningAdapters, verifyFinalSignedIdentifiers } from "./macos-release-workflow.mjs";

function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

test("workflow adapters rebuild macOS outers from signed helpers and repack the signed resource tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-workflow-"));
	const workspaceRoot = join(root, "workspace");
	const releaseDir = join(root, "release");
	const resourceRoot = join(root, "resources");
	const embeddedPayloads = MACOS_EMBEDDED_PAYLOADS.map((payload) => ({
		...payload,
		path: join(root, "signed", payload.relativePath),
	}));
	const outerBinaries = [
		{ architecture: "arm64", assetName: "magenta-macos-arm64", path: join(releaseDir, "magenta-macos-arm64") },
		{ architecture: "x64", assetName: "magenta-macos-x64", path: join(releaseDir, "magenta-macos-x64") },
	];
	const clipboard = {
		afterSha256: "",
		path: join(resourceRoot, MACOS_CLIPBOARD_RESOURCE_PATH),
		relativePath: MACOS_CLIPBOARD_RESOURCE_PATH,
	};
	for (const payload of embeddedPayloads) write(payload.path, `signed:${payload.relativePath}\n`);
	for (const payload of embeddedPayloads) payload.afterSha256 = sha256File(payload.path);
	for (const outer of outerBinaries) write(outer.path, `unsigned:${outer.assetName}\n`);
	write(clipboard.path, "signed clipboard\n");
	write(join(resourceRoot, "README.md"), "resources\n");
	clipboard.afterSha256 = sha256File(clipboard.path);
	const calls = [];
	const runCommand = (command, args, options = {}) => {
		calls.push({ args, command, options });
		if (command === "npm") {
			for (const outer of outerBinaries) {
				const matchingPayloads = embeddedPayloads.filter(
					(payload) => payload.architecture === outer.architecture,
				);
				write(
					join(workspaceRoot, "pi/coding-agent/dist/release", outer.assetName),
					Buffer.concat([
						Buffer.from(`rebuilt:${outer.assetName}\n`),
						...matchingPayloads.map((payload) => readFileSync(payload.path)),
					]),
				);
			}
			return { status: 0 };
		}
		if (command === "tar") {
			return spawnSync(command, args, {
				cwd: options.cwd,
				encoding: "utf8",
				env: options.env ?? process.env,
			});
		}
		throw new Error(`Unexpected command: ${command}`);
	};
	const releaseSupport = {
		inspectReleaseResourceArchive: async () => ["runtime", "README.md"],
		validateExtractedReleaseResources: async () => undefined,
	};
	try {
		const adapters = createWorkflowSigningAdapters({
			expectedVersion: "0.0.30",
			releaseDir,
			releaseSupport,
			resourceRoot,
			runCommand,
			topLevelNames: ["runtime", "README.md"],
			workspaceRoot,
		});
		const rebuild = await adapters.rebuildOuterBinaries({ embeddedPayloads, outerBinaries });
		assert.equal(readFileSync(outerBinaries[0].path, "utf8").startsWith("rebuilt:magenta-macos-arm64\n"), true);
		assert.deepEqual(
			rebuild.embeddedPayloadSha256,
			Object.fromEntries(embeddedPayloads.map((payload) => [payload.relativePath, sha256File(payload.path)])),
		);

		const resourceArchivePath = join(releaseDir, "magenta-resources-universal.tar.gz");
		const repack = await adapters.repackResourceArchive({ clipboard, resourceArchivePath });
		assert.equal(repack.clipboardSha256, clipboard.afterSha256);
		assert.equal(repack.resourceArchiveSha256, sha256File(resourceArchivePath));
		const rebuildCall = calls.find(
			(call) => call.command === "npm" && call.args.join(" ") === "run build:release-all",
		);
		assert.equal(rebuildCall?.options.timeout, 90 * 60 * 1000);
		assert.ok(calls.some((call) => call.command === "tar" && call.options.cwd === resourceRoot));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workflow adapter rejects a rebuilt outer that contains stale helper bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-stale-outer-"));
	const workspaceRoot = join(root, "workspace");
	const releaseDir = join(root, "release");
	const resourceRoot = join(root, "resources");
	const embeddedPayloads = MACOS_EMBEDDED_PAYLOADS.map((payload) => ({
		...payload,
		path: join(root, "signed", payload.relativePath),
	}));
	const outerBinaries = MACOS_OUTER_BINARIES.map((outer) => ({
		...outer,
		path: join(releaseDir, outer.assetName),
	}));
	for (const payload of embeddedPayloads) {
		write(payload.path, `signed:${payload.relativePath}\n`);
		payload.afterSha256 = sha256File(payload.path);
	}
	mkdirSync(releaseDir, { recursive: true });
	const runCommand = (command) => {
		assert.equal(command, "npm");
		for (const outer of outerBinaries) {
			write(join(workspaceRoot, "pi/coding-agent/dist/release", outer.assetName), `stale:${outer.assetName}\n`);
		}
		return { status: 0 };
	};
	try {
		const adapters = createWorkflowSigningAdapters({
			expectedVersion: "0.0.30",
			releaseDir,
			releaseSupport: {},
			resourceRoot,
			runCommand,
			topLevelNames: [],
			workspaceRoot,
		});
		await assert.rejects(
			() => adapters.rebuildOuterBinaries({ embeddedPayloads, outerBinaries }),
			/does not contain signed embedded payload bytes/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workflow adapter rejects a resource archive containing stale clipboard bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-stale-archive-"));
	const workspaceRoot = join(root, "workspace");
	const releaseDir = join(root, "release");
	const resourceRoot = join(root, "resources");
	const clipboard = {
		afterSha256: "",
		path: join(resourceRoot, MACOS_CLIPBOARD_RESOURCE_PATH),
		relativePath: MACOS_CLIPBOARD_RESOURCE_PATH,
	};
	write(clipboard.path, "signed clipboard\n");
	mkdirSync(releaseDir, { recursive: true });
	clipboard.afterSha256 = sha256File(clipboard.path);
	const signedClipboard = readFileSync(clipboard.path);
	const runCommand = (command, args, options = {}) => {
		assert.equal(command, "tar");
		if (args[0] === "-czf") write(clipboard.path, "stale clipboard\n");
		const result = spawnSync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			env: options.env ?? process.env,
		});
		if (args[0] === "-czf") writeFileSync(clipboard.path, signedClipboard);
		return result;
	};
	const releaseSupport = {
		inspectReleaseResourceArchive: async () => ["runtime"],
		validateExtractedReleaseResources: async () => undefined,
	};
	try {
		const adapters = createWorkflowSigningAdapters({
			expectedVersion: "0.0.30",
			releaseDir,
			releaseSupport,
			resourceRoot,
			runCommand,
			topLevelNames: ["runtime"],
			workspaceRoot,
		});
		await assert.rejects(
			() =>
				adapters.repackResourceArchive({
					clipboard,
					resourceArchivePath: join(releaseDir, "magenta-resources-universal.tar.gz"),
				}),
			/does not contain the signed clipboard bytes/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workflow adapter independently binds every final code-signing Identifier", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-identifiers-"));
	const embeddedRoot = join(root, "embedded");
	const releaseDir = join(root, "release");
	const resourceRoot = join(root, "resources");
	const identifiers = new Map();
	for (const payload of MACOS_EMBEDDED_PAYLOADS) {
		const path = join(embeddedRoot, payload.relativePath);
		write(path, payload.relativePath);
		identifiers.set(path, payload.identifier);
	}
	const clipboardPath = join(resourceRoot, MACOS_CLIPBOARD_RESOURCE_PATH);
	write(clipboardPath, "clipboard");
	identifiers.set(clipboardPath, "land.minions.magenta.clipboard");
	for (const outer of MACOS_OUTER_BINARIES) {
		const path = join(releaseDir, outer.assetName);
		write(path, outer.assetName);
		identifiers.set(path, outer.identifier);
	}
	const runCommand = (_command, args) => ({ status: 0, stderr: `Identifier=${identifiers.get(args.at(-1))}\n`, stdout: "" });
	try {
		assert.doesNotThrow(() => verifyFinalSignedIdentifiers({ embeddedRoot, releaseDir, resourceRoot, runCommand }));
		identifiers.set(join(releaseDir, "magenta-macos-arm64"), "land.minions.wrong");
		assert.throws(
			() => verifyFinalSignedIdentifiers({ embeddedRoot, releaseDir, resourceRoot, runCommand }),
			/outer Identifier mismatch/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
