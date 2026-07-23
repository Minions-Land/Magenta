import type { Stats } from "node:fs";
import { lstat, rmdir, unlink } from "node:fs/promises";

export type OwnedPathKind = "directory" | "file" | "socket";

/**
 * Immutable identity used immediately before deleting a reproducible artifact.
 * String device/inode fields keep comparisons exact if Node exposes bigint
 * stats in a future caller.
 */
export type OwnedPathSnapshot = {
	kind: OwnedPathKind;
	device: string;
	inode: string;
	uid: number;
	nlink: number;
	size: number;
	mtimeMs: number;
};

export function currentUserId(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function hasKind(stats: Stats, kind: OwnedPathKind): boolean {
	switch (kind) {
		case "directory":
			return stats.isDirectory();
		case "file":
			return stats.isFile();
		case "socket":
			return stats.isSocket();
	}
}

/**
 * Capture only a plain path owned by the current POSIX user. When the runtime
 * cannot prove ownership (notably platforms without getuid), cleanup skips it.
 */
export async function snapshotOwnedPath(
	path: string,
	kind: OwnedPathKind,
	ownerUid = currentUserId(),
): Promise<OwnedPathSnapshot | undefined> {
	if (ownerUid === undefined) return undefined;
	let stats: Stats;
	try {
		stats = await lstat(path);
	} catch {
		return undefined;
	}
	if (stats.isSymbolicLink() || !hasKind(stats, kind) || stats.uid !== ownerUid) return undefined;
	if (kind !== "directory" && stats.nlink !== 1) return undefined;
	return {
		kind,
		device: String(stats.dev),
		inode: String(stats.ino),
		uid: stats.uid,
		nlink: stats.nlink,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}

export function ownedPathSnapshotMatches(left: OwnedPathSnapshot, right: OwnedPathSnapshot): boolean {
	return (
		left.kind === right.kind &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.uid === right.uid &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

/** Remove a path only if owner, type, inode, size, and mtime still match. */
export async function removeOwnedPathIfUnchanged(path: string, snapshot: OwnedPathSnapshot): Promise<boolean> {
	const ownerUid = currentUserId();
	if (ownerUid === undefined || ownerUid !== snapshot.uid) return false;
	const current = await snapshotOwnedPath(path, snapshot.kind, ownerUid);
	if (!current || !ownedPathSnapshotMatches(snapshot, current)) return false;
	try {
		if (snapshot.kind === "directory") await rmdir(path);
		else await unlink(path);
		return true;
	} catch {
		return false;
	}
}
