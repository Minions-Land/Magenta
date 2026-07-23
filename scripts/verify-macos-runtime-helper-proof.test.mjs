import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { MACOS_EMBEDDED_PAYLOADS } from "./macos-release-bundle-contract.mjs";
import { verifyMacosRuntimeHelperProof } from "./verify-macos-runtime-helper-proof.mjs";

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-runtime-proof-"));
	const cacheRoot = join(root, "home/.magenta/cache");
	const paths = {
		fd: join(cacheRoot, "fd/fd"),
		"process-tools": join(cacheRoot, "process-tools/magenta-process-tools"),
		rg: join(cacheRoot, "rg/rg"),
	};
	const embedded = {};
	for (const [kind, path] of Object.entries(paths)) {
		const content = Buffer.from(`signed:${kind}\n`);
		write(path, content);
		const prefix = kind === "process-tools" ? "process-tools/prebuilt/magenta-process-tools" : `${kind}/prebuilt/${kind}`;
		embedded[`${prefix}-macos-arm64`] = sha256(content);
	}
	for (const payload of MACOS_EMBEDDED_PAYLOADS.filter(({ architecture }) => architecture === "x64")) {
		embedded[payload.relativePath] = "f".repeat(64);
	}
	const proofPath = join(root, "proof.json");
	writeFileSync(
		proofPath,
		JSON.stringify({
			architecture: "arm64",
			helpers: Object.entries(paths).map(([kind, path]) => ({
				kind,
				path,
				sha256: sha256(Buffer.from(`signed:${kind}\n`)),
				size: Buffer.byteLength(`signed:${kind}\n`),
			})),
			platform: "darwin",
			schema: "magenta.release-embedded-helper-proof.v1",
		}),
	);
	const receiptPath = join(root, "receipt.json");
	writeFileSync(
		receiptPath,
		JSON.stringify({ payloads: { embedded }, schema: "magenta.macos-signing-receipt.v1" }),
	);
	return { cacheRoot, paths, proofPath, receiptPath, root };
}

test("accepts only runtime-materialized helpers matching the signed receipt", () => {
	const value = fixture();
	try {
		const verified = verifyMacosRuntimeHelperProof({
			architecture: "arm64",
			cacheRoot: value.cacheRoot,
			proofPath: value.proofPath,
			receiptPath: value.receiptPath,
		});
		assert.equal(verified.schema, "magenta.verified-runtime-helper-proof.v1");
		assert.deepEqual(verified.helpers.map(({ kind }) => kind), ["fd", "process-tools", "rg"]);
		assert.deepEqual(verified.helpers.map(({ identifier }) => identifier), [
			"land.minions.magenta.fd",
			"land.minions.magenta.process-tools",
			"land.minions.magenta.rg",
		]);
	} finally {
		rmSync(value.root, { force: true, recursive: true });
	}
});

test("rejects stale receipt bytes and paths outside the isolated cache", () => {
	const value = fixture();
	try {
		const receipt = JSON.parse(readFileSync(value.receiptPath, "utf8"));
		receipt.payloads.embedded["fd/prebuilt/fd-macos-arm64"] = "0".repeat(64);
		writeFileSync(value.receiptPath, JSON.stringify(receipt));
		assert.throws(
			() =>
				verifyMacosRuntimeHelperProof({
					architecture: "arm64",
					cacheRoot: value.cacheRoot,
					proofPath: value.proofPath,
					receiptPath: value.receiptPath,
				}),
			/signed build receipt/u,
		);

		receipt.payloads.embedded["fd/prebuilt/fd-macos-arm64"] = sha256(Buffer.from("signed:fd\n"));
		writeFileSync(value.receiptPath, JSON.stringify(receipt));
		const outside = join(value.root, "outside-fd");
		write(outside, "signed:fd\n");
		const proof = JSON.parse(readFileSync(value.proofPath, "utf8"));
		proof.helpers.find(({ kind }) => kind === "fd").path = outside;
		writeFileSync(value.proofPath, JSON.stringify(proof));
		assert.throws(
			() =>
				verifyMacosRuntimeHelperProof({
					architecture: "arm64",
					cacheRoot: value.cacheRoot,
					proofPath: value.proofPath,
					receiptPath: value.receiptPath,
				}),
			/escaped the isolated proof cache/u,
		);
	} finally {
		rmSync(value.root, { force: true, recursive: true });
	}
});

test("rejects symbolic-link helper substitutions", () => {
	const value = fixture();
	try {
		const outside = join(value.root, "outside-rg");
		write(outside, "signed:rg\n");
		rmSync(value.paths.rg);
		symlinkSync(outside, value.paths.rg);
		assert.throws(
			() =>
				verifyMacosRuntimeHelperProof({
					architecture: "arm64",
					cacheRoot: value.cacheRoot,
					proofPath: value.proofPath,
					receiptPath: value.receiptPath,
				}),
			/not a regular file/u,
		);
	} finally {
		rmSync(value.root, { force: true, recursive: true });
	}
});
