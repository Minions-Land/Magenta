import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	currentUserId,
	type OwnedPathSnapshot,
	removeOwnedPathIfUnchanged,
	snapshotOwnedPath,
} from "../../../_magenta/owned-path.ts";

export const DEFAULT_WAKE_SOCKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WAKE_SOCKET_PROBE_TIMEOUT_MS = 250;
export const DEFAULT_WAKE_SOCKET_MAX_SCANNED = 32;
export const DEFAULT_WAKE_SOCKET_MAX_DELETED = 8;

const WAKE_SOCKET_NAME = /^magenta-wake-(\d+)-([0-9a-f]{20})\.sock$/;
let cleanupScheduled = false;

export type WakeSocketCleanupOptions = {
	tempRoot?: string;
	maxAgeMs?: number;
	probeTimeoutMs?: number;
	maxScannedSockets?: number;
	maxDeletedSockets?: number;
	now?: number;
};

export type WakeSocketCleanupResult = {
	scannedSockets: number;
	deletedSockets: number;
};

function definitelyDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

type ProbeResult = "reachable" | "unreachable" | "uncertain";

function probeSocket(path: string, timeoutMs: number): Promise<ProbeResult> {
	return new Promise((resolveResult) => {
		let settled = false;
		let socket: ReturnType<typeof createConnection>;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: ProbeResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket?.destroy();
			resolveResult(result);
		};
		try {
			socket = createConnection(path);
		} catch {
			finish("uncertain");
			return;
		}
		socket.unref?.();
		timer = setTimeout(() => finish("uncertain"), timeoutMs);
		timer.unref?.();
		socket.once("connect", () => finish("reachable"));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED") finish("unreachable");
			else finish("uncertain");
		});
	});
}

function isPlainDirectory(entry: Awaited<ReturnType<typeof lstat>>): boolean {
	return entry.isDirectory() && !entry.isSymbolicLink();
}

/**
 * Remove stale Unix wake sockets only after name, owner, socket type, age, dead
 * PID, failed connection probe, and final inode checks all agree. A live PID,
 * EPERM, timeout, successful probe, lock-like ambiguity, or unknown error keeps
 * the path untouched.
 */
export async function cleanupStaleWakeSockets(
	options: WakeSocketCleanupOptions = {},
): Promise<WakeSocketCleanupResult> {
	const result: WakeSocketCleanupResult = { scannedSockets: 0, deletedSockets: 0 };
	if (process.platform === "win32" || currentUserId() === undefined) return result;
	const root = resolve(options.tempRoot ?? tmpdir());
	let rootStats: Awaited<ReturnType<typeof lstat>>;
	try {
		rootStats = await lstat(root);
	} catch {
		return result;
	}
	if (!isPlainDirectory(rootStats)) return result;
	let entries: Dirent<string>[];
	try {
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return result;
	}
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_WAKE_SOCKET_MAX_AGE_MS;
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_WAKE_SOCKET_PROBE_TIMEOUT_MS;
	const maxScannedSockets = options.maxScannedSockets ?? DEFAULT_WAKE_SOCKET_MAX_SCANNED;
	const maxDeletedSockets = options.maxDeletedSockets ?? DEFAULT_WAKE_SOCKET_MAX_DELETED;
	for (const [label, value] of [
		["wake socket scan limit", maxScannedSockets],
		["wake socket deletion limit", maxDeletedSockets],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new TypeError(`${label} must be a non-negative safe integer`);
	}
	for (const entry of entries) {
		const match = WAKE_SOCKET_NAME.exec(entry.name);
		if (!match || !entry.isSocket() || entry.isSymbolicLink()) continue;
		if (result.scannedSockets >= maxScannedSockets || result.deletedSockets >= maxDeletedSockets) break;
		result.scannedSockets++;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || !definitelyDead(pid)) continue;
		const path = join(root, entry.name);
		const snapshot: OwnedPathSnapshot | undefined = await snapshotOwnedPath(path, "socket");
		if (!snapshot || maxAgeMs < 0 || now - snapshot.mtimeMs < maxAgeMs) continue;
		if ((await probeSocket(path, probeTimeoutMs)) !== "unreachable") continue;
		if (await removeOwnedPathIfUnchanged(path, snapshot)) result.deletedSockets++;
	}
	return result;
}

/** Schedule at most one best-effort maintenance pass per process. */
export function scheduleStaleWakeSocketCleanup(): void {
	if (cleanupScheduled || process.platform === "win32") return;
	cleanupScheduled = true;
	const timer = setTimeout(() => {
		void cleanupStaleWakeSockets().catch(() => undefined);
	}, 0);
	timer.unref?.();
}
