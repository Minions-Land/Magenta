#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MACOS_EMBEDDED_PAYLOADS } from "./macos-release-bundle-contract.mjs";

const PROOF_SCHEMA = "magenta.release-embedded-helper-proof.v1";
const RECEIPT_SCHEMA = "magenta.macos-signing-receipt.v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function parseJsonFile(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertExactKeys(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an unsupported schema.`);
}

function pathIsWithin(parent, candidate) {
	const pathFromParent = relative(parent, candidate);
	return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyMacosRuntimeHelperProof({ architecture, cacheRoot, proofPath, receiptPath }) {
	if (architecture !== "arm64" && architecture !== "x64") {
		throw new Error(`Unsupported macOS helper-proof architecture: ${architecture}`);
	}
	const proof = parseJsonFile(proofPath, "Runtime helper proof");
	assertExactKeys(proof, ["architecture", "helpers", "platform", "schema"], "Runtime helper proof");
	if (proof.schema !== PROOF_SCHEMA || proof.platform !== "darwin" || proof.architecture !== architecture) {
		throw new Error("Runtime helper proof identity does not match the native smoke runner.");
	}
	if (!Array.isArray(proof.helpers) || proof.helpers.length !== 3) {
		throw new Error("Runtime helper proof must contain exactly three helpers.");
	}

	const receipt = parseJsonFile(receiptPath, "macOS signing receipt");
	if (receipt?.schema !== RECEIPT_SCHEMA || !receipt.payloads?.embedded) {
		throw new Error("macOS signing receipt does not contain embedded helper evidence.");
	}
	const embedded = receipt.payloads.embedded;
	const expectedEmbeddedPaths = MACOS_EMBEDDED_PAYLOADS.map(({ relativePath }) => relativePath);
	assertExactKeys(embedded, expectedEmbeddedPaths, "macOS signing receipt embedded helper evidence");
	for (const path of expectedEmbeddedPaths) {
		if (typeof embedded[path] !== "string" || !SHA256_PATTERN.test(embedded[path])) {
			throw new Error(`macOS signing receipt has an invalid embedded helper hash: ${path}`);
		}
	}
	const helperContract = new Map(
		MACOS_EMBEDDED_PAYLOADS.filter((entry) => entry.architecture === architecture).map((entry) => [entry.kind, entry]),
	);
	if (helperContract.size !== 3) throw new Error("macOS helper-proof contract is incomplete for this architecture.");
	const canonicalCacheRoot = realpathSync(resolve(cacheRoot));
	const seen = new Set();
	const verified = [];
	for (const helper of proof.helpers) {
		assertExactKeys(helper, ["kind", "path", "sha256", "size"], "Runtime helper entry");
		const contract = helperContract.get(helper.kind);
		if (!contract || seen.has(helper.kind)) throw new Error(`Unexpected or duplicate runtime helper: ${helper.kind}`);
		seen.add(helper.kind);
		if (!isAbsolute(helper.path)) throw new Error(`Runtime helper path is not absolute: ${helper.kind}`);
		const inputStats = lstatSync(helper.path);
		if (!inputStats.isFile() || inputStats.isSymbolicLink()) {
			throw new Error(`Runtime helper is not a regular file: ${helper.kind}`);
		}
		const canonicalPath = realpathSync(helper.path);
		if (!pathIsWithin(canonicalCacheRoot, canonicalPath)) {
			throw new Error(`Runtime helper escaped the isolated proof cache: ${helper.kind}`);
		}
		const actualSha256 = sha256File(canonicalPath);
		if (!SHA256_PATTERN.test(helper.sha256) || helper.sha256 !== actualSha256) {
			throw new Error(`Runtime helper bytes do not match their proof: ${helper.kind}`);
		}
		if (!Number.isSafeInteger(helper.size) || helper.size <= 0 || helper.size !== inputStats.size) {
			throw new Error(`Runtime helper size does not match its proof: ${helper.kind}`);
		}
		const receiptPathKey = contract.relativePath;
		if (embedded[receiptPathKey] !== actualSha256) {
			throw new Error(`Runtime helper does not match the signed build receipt: ${helper.kind}`);
		}
		verified.push({
			identifier: contract.identifier,
			kind: helper.kind,
			path: canonicalPath,
			sha256: actualSha256,
		});
	}
	if (seen.size !== helperContract.size) {
		throw new Error("Runtime helper proof is incomplete.");
	}
	return {
		architecture,
		helpers: verified.sort((left, right) => left.kind.localeCompare(right.kind)),
		schema: "magenta.verified-runtime-helper-proof.v1",
	};
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
		architecture: required("--architecture"),
		cacheRoot: required("--cache-root"),
		proofPath: required("--proof"),
		receiptPath: required("--receipt"),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.stdout.write(`${JSON.stringify(verifyMacosRuntimeHelperProof(parseArguments(process.argv.slice(2))))}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
