#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MACOS_RELEASE_TRUST_SCHEMA = "magenta.macos-release-trust.v1";
export const MACOS_RELEASE_TRUST_PLACEHOLDER = "UNCONFIGURED";
export const MACOS_RELEASE_TRUST_PATH = fileURLToPath(new URL("./macos-release-trust.json", import.meta.url));

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

export function normalizeAppleTeamId(value, label = "Apple Team ID") {
	if (typeof value !== "string" || !APPLE_TEAM_ID_PATTERN.test(value)) {
		throw new Error(`${label} must be exactly 10 uppercase ASCII letters or digits.`);
	}
	return value;
}

export function parseMacosReleaseTrust(
	content,
	label = "macOS release trust configuration",
	{ allowUnconfigured = false } = {},
) {
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`${label} is not valid JSON.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	const keys = Object.keys(parsed).sort();
	if (JSON.stringify(keys) !== JSON.stringify(["appleTeamId", "schema"])) {
		throw new Error(`${label} must contain only schema and appleTeamId.`);
	}
	if (parsed.schema !== MACOS_RELEASE_TRUST_SCHEMA) {
		throw new Error(`${label} has an unsupported schema.`);
	}
	if (parsed.appleTeamId === MACOS_RELEASE_TRUST_PLACEHOLDER) {
		if (allowUnconfigured) {
			return Object.freeze({
				appleTeamId: MACOS_RELEASE_TRUST_PLACEHOLDER,
				schema: MACOS_RELEASE_TRUST_SCHEMA,
			});
		}
		throw new Error(
			`macOS release trust is unconfigured; commit the real Apple Team ID to ${MACOS_RELEASE_TRUST_PATH}.`,
		);
	}
	return Object.freeze({
		appleTeamId: normalizeAppleTeamId(parsed.appleTeamId, "Source-owned Apple Team ID"),
		schema: MACOS_RELEASE_TRUST_SCHEMA,
	});
}

export function readMacosReleaseTrust(path = MACOS_RELEASE_TRUST_PATH, options) {
	return parseMacosReleaseTrust(readFileSync(resolve(path), "utf8"), path, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 2) throw new Error("macos-release-trust.mjs does not accept arguments.");
		process.stdout.write(`${readMacosReleaseTrust().appleTeamId}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
