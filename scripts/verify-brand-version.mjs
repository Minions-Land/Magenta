#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readActiveBrandMetadata } from "./brand-metadata.mjs";
import { assertCleanCompiledDist } from "./verify-clean-dist.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_VERSION_PATH = "pi/coding-agent/src/brand-version.generated.ts";
const COMPILED_VERSION_PATH = "pi/coding-agent/dist/brand-version.generated.js";
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function readRequiredFile(path, label) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(
			`Could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function readVersionExport(source, exportName, label) {
	const pattern = new RegExp(
		`^export\\s+const\\s+${exportName}(?:\\s*:\\s*string)?\\s*=\\s*["']([^"']+)["']\\s*;?\\s*$`,
		"gmu",
	);
	const matches = [...source.matchAll(pattern)];
	if (matches.length !== 1) {
		throw new Error(`Expected exactly one ${exportName} assignment in ${label}, found ${matches.length}.`);
	}
	return matches[0][1];
}

function assertVersion(value, label) {
	if (!SEMVER_RE.test(value)) throw new Error(`Invalid ${label}: ${value}. Expected x.y.z.`);
}

export function assertMatchingVersions(entries, expectedVersion) {
	if (expectedVersion !== undefined) assertVersion(expectedVersion, "expected release version");
	for (const [label, value] of entries) assertVersion(value, label);

	const referenceVersion = expectedVersion ?? entries[0]?.[1];
	if (!referenceVersion) throw new Error("No version inputs were provided.");
	const mismatches = entries.filter(([, value]) => value !== referenceVersion);
	if (mismatches.length > 0) {
		const state = entries.map(([label, value]) => `${label}=${value}`).join(", ");
		const expectation = expectedVersion ? `expected release=${expectedVersion}, ` : "";
		throw new Error(
			`Magenta version mismatch: ${expectation}${state}. Rebuild generated artifacts with npm run build.`,
		);
	}
	return referenceVersion;
}

export function verifyBrandVersion({
	expectedVersion,
	requireDist = false,
	resourceMarker,
	root = REPO_ROOT,
} = {}) {
	const absoluteRoot = resolve(root);
	const brand = readActiveBrandMetadata(absoluteRoot);
	const generatedPath = resolve(absoluteRoot, GENERATED_VERSION_PATH);
	const generatedVersion = readVersionExport(
		readRequiredFile(generatedPath, "generated brand version"),
		"BRAND_VERSION",
		GENERATED_VERSION_PATH,
	);
	const entries = [
		["active brand", brand.version],
		["generated source", generatedVersion],
	];

	if (requireDist) {
		const compiledPath = resolve(absoluteRoot, COMPILED_VERSION_PATH);
		entries.push([
			"compiled dist",
			readVersionExport(
				readRequiredFile(compiledPath, "compiled brand version"),
				"BRAND_VERSION",
				COMPILED_VERSION_PATH,
			),
		]);
	}

	if (resourceMarker) {
		const markerPath = resolve(absoluteRoot, resourceMarker);
		let marker;
		try {
			marker = JSON.parse(readRequiredFile(markerPath, "release resource marker"));
		} catch (error) {
			if (error instanceof SyntaxError) throw new Error(`Invalid release resource marker JSON at ${markerPath}.`);
			throw error;
		}
		if (typeof marker?.version !== "string") {
			throw new Error(`Release resource marker at ${markerPath} has no string version.`);
		}
		entries.push(["resource marker", marker.version]);
	}

	const version = assertMatchingVersions(entries, expectedVersion);
	if (requireDist) assertCleanCompiledDist(absoluteRoot);
	return { entries, version };
}

function parseArgs(args) {
	const options = { expectedVersion: undefined, requireDist: false, resourceMarker: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--require-dist") {
			options.requireDist = true;
			continue;
		}
		if (arg === "--expected" || arg === "--resource-marker") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value.`);
			if (arg === "--expected") options.expectedVersion = value;
			else options.resourceMarker = value;
			continue;
		}
		throw new Error(
			"Usage: node scripts/verify-brand-version.mjs [--expected x.y.z] [--require-dist] [--resource-marker path]",
		);
	}
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = verifyBrandVersion(parseArgs(process.argv.slice(2)));
		console.log(`Verified Magenta v${result.version}: ${result.entries.map(([label]) => label).join(", ")}.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
