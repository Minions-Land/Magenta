import { isBunBinary } from "../config.ts";

export interface ProcessRespawnInvocation {
	command: string;
	args: string[];
}

interface ProcessRespawnSnapshot {
	argv: readonly string[];
	execPath: string;
	isCompiledBinary: boolean;
}

/** Resolve the real executable and arguments needed to replace this process. */
export function resolveProcessRespawnInvocation(
	snapshot: ProcessRespawnSnapshot = {
		argv: process.argv,
		execPath: process.execPath,
		isCompiledBinary: isBunBinary,
	},
): ProcessRespawnInvocation {
	if (!snapshot.execPath) throw new Error("Cannot restart Magenta without process.execPath");
	const argumentOffset = snapshot.isCompiledBinary ? 2 : 1;
	if (snapshot.argv.length < argumentOffset) {
		throw new Error("Cannot restart Magenta from an incomplete process argument vector");
	}
	return {
		command: snapshot.execPath,
		args: snapshot.argv.slice(argumentOffset),
	};
}
