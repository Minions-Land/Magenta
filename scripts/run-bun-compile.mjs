#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanCodingAgentBunScratch } from "./clean-coding-agent-build.mjs";

export function runBunCompile({
	args,
	cleanScratch = cleanCodingAgentBunScratch,
	cwd = process.cwd(),
	runCommand = spawnSync,
}) {
	if (!Array.isArray(args) || args[0] !== "build" || !args.includes("--compile")) {
		throw new Error("run-bun-compile requires bun build --compile arguments");
	}
	let result;
	let operationError;
	try {
		result = runCommand("bun", args, { cwd: resolve(cwd), stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.signal) throw new Error(`bun build terminated by ${result.signal}`);
		if (!Number.isInteger(result.status)) throw new Error("bun build returned no exit status");
	} catch (error) {
		operationError = error;
	}

	let cleanupError;
	try {
		cleanScratch(resolve(cwd));
	} catch (error) {
		cleanupError = error;
	}
	if (operationError && cleanupError) {
		throw new AggregateError([operationError, cleanupError], "Bun compile failed and scratch cleanup was incomplete");
	}
	if (operationError) throw operationError;
	if (cleanupError) throw cleanupError;
	return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = runBunCompile({ args: process.argv.slice(2) });
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
