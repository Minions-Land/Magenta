#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMacosReleaseTrust } from "./macos-release-trust.mjs";

export function verifyMacosReleaseTrustAgreement({ distributionPath, sourcePath }) {
	const source = readMacosReleaseTrust(sourcePath);
	const distribution = readMacosReleaseTrust(distributionPath);
	if (source.appleTeamId !== distribution.appleTeamId) {
		throw new Error("Distribution repository Apple Team ID does not match source-owned release trust.");
	}
	return source.appleTeamId;
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
	for (const flag of values.keys()) {
		if (flag !== "--source" && flag !== "--distribution") throw new Error(`Unknown argument: ${flag}`);
	}
	const sourcePath = values.get("--source");
	const distributionPath = values.get("--distribution");
	if (!sourcePath || !distributionPath) throw new Error("--source and --distribution are required.");
	return { distributionPath, sourcePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const teamId = verifyMacosReleaseTrustAgreement(parseArguments(process.argv.slice(2)));
		process.stdout.write(`macos_release_trust_team_id=${teamId}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
