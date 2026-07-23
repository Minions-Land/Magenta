import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

/**
 * Relay locks are filesystem leases, not a mailbox heartbeat.  Keep the
 * refresh below the legacy 30-second stale window so an older Magenta process
 * cannot mistake a healthy new-version owner for a dead one, while allowing a
 * much longer lease to avoid needless directory-mtime writes.  A crashed
 * owner is therefore eligible for takeover after at most 60 seconds from its
 * last successful refresh (plus normal scheduler/filesystem latency).
 */
export const PEER_RELAY_LOCK_STALE_MS = 60_000;
export const PEER_RELAY_LOCK_UPDATE_MS = 20_000;
export const PEER_RELAY_LOCK_MAX_TAKEOVER_MS = PEER_RELAY_LOCK_STALE_MS;
const RELAY_GENERATION_FENCING_OPTIONS = new Set(["--generation", "--generation-command", "--generation-args"]);
const BUN_VIRTUAL_PATH_PATTERN = /(?:\$bunfs|~bun|%7ebun)/i;

export function peerRelayGenerationArgs(args: readonly string[]): string[] {
	const normalized: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (RELAY_GENERATION_FENCING_OPTIONS.has(args[index]!)) {
			index += 1;
			continue;
		}
		normalized.push(args[index]!);
	}
	return normalized;
}

/** Reconstruct a self-spawnable argv from Node or a compiled Bun executable. */
export function peerRelayProcessArgs(argv: readonly string[] = process.argv): string[] {
	const args = argv.slice(1);
	const peerCommandIndex = args.indexOf("_peer");
	if (peerCommandIndex > 0 && args.slice(0, peerCommandIndex).every((entry) => BUN_VIRTUAL_PATH_PATTERN.test(entry))) {
		return peerRelayGenerationArgs(args.slice(peerCommandIndex));
	}
	return peerRelayGenerationArgs(args);
}

export function encodePeerRelayGenerationArgs(args: readonly string[]): string {
	return Buffer.from(JSON.stringify(peerRelayGenerationArgs(args)), "utf8").toString("base64url");
}

export function decodePeerRelayGenerationArgs(encoded: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new Error("invalid peer relay generation args");
	}
	if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
		throw new Error("invalid peer relay generation args");
	}
	return peerRelayGenerationArgs(parsed);
}

function resolveExecutable(command: string): string {
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return resolve(command);
	const extensions =
		process.platform === "win32"
			? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
			: [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = join(directory, `${command}${extension}`);
			try {
				accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return resolve(candidate);
			} catch {
				// Continue through PATH/PATHEXT.
			}
		}
	}
	return command;
}

/** Fingerprint the on-disk command that a supervisor will use for a relay. */
export function peerRelayGeneration(invocation: { command: string; args: readonly string[] }): string {
	const args = peerRelayGenerationArgs(invocation.args);
	const peerCommandIndex = args.indexOf("_peer");
	const executablePaths = [
		resolveExecutable(invocation.command),
		...(peerCommandIndex < 0 ? [] : args.slice(0, peerCommandIndex)),
	];
	const artifacts = executablePaths.map((path) => {
		try {
			const stat = statSync(path);
			return {
				path: resolve(path),
				device: stat.dev,
				inode: stat.ino,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
			};
		} catch {
			return { path };
		}
	});
	return createHash("sha256")
		.update(JSON.stringify({ command: invocation.command, args, artifacts }))
		.digest("hex");
}

export function peerRelayGenerationMatches(
	expected: string,
	invocation: { command: string; args: readonly string[] },
): boolean {
	return peerRelayGeneration(invocation) === expected;
}

export function peerRelayLockPath(dbPath: string, endpointId: string): string {
	const endpointHash = createHash("sha256").update(endpointId).digest("hex").slice(0, 16);
	return `${resolve(dbPath)}.relay-${endpointHash}.lock`;
}

function peerRelayLockOptions(
	dbPath: string,
	endpointId: string,
): {
	realpath: false;
	lockfilePath: string;
	stale: number;
} {
	return {
		realpath: false,
		lockfilePath: peerRelayLockPath(dbPath, endpointId),
		stale: PEER_RELAY_LOCK_STALE_MS,
	};
}

export async function acquirePeerRelayLock(
	dbPath: string,
	endpointId: string,
	onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
	const target = resolve(dbPath);
	return lockfile.lock(target, {
		...peerRelayLockOptions(target, endpointId),
		update: PEER_RELAY_LOCK_UPDATE_MS,
		retries: 0,
		onCompromised,
	});
}

export function isPeerRelayLockActive(dbPath: string, endpointId: string): boolean {
	const target = resolve(dbPath);
	return lockfile.checkSync(target, peerRelayLockOptions(target, endpointId));
}
