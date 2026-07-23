import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquirePeerRelayLock,
	isPeerRelayLockActive,
	PEER_RELAY_LOCK_MAX_TAKEOVER_MS,
	PEER_RELAY_LOCK_STALE_MS,
	PEER_RELAY_LOCK_UPDATE_MS,
	peerRelayLockPath,
	peerRelayProcessArgs,
} from "../../tools/send-message/magenta/peer-relay-lock.ts";

describe("peer relay self-spawn argv", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
	});

	it("removes the embedded Bun entrypoint on Unix and Windows", () => {
		expect(
			peerRelayProcessArgs(["/tmp/magenta", "/$bunfs/root/magenta", "_peer", "relay", "--db", "/tmp/messages.db"]),
		).toEqual(["_peer", "relay", "--db", "/tmp/messages.db"]);
		expect(
			peerRelayProcessArgs(["C:\\Magenta\\magenta.exe", "B:\\~BUN\\root\\magenta.exe", "_peer", "relay"]),
		).toEqual(["_peer", "relay"]);
	});

	it("preserves a real script entrypoint for Node and strips fencing options", () => {
		expect(
			peerRelayProcessArgs([
				"/opt/homebrew/bin/node",
				"/repo/dist/cli.js",
				"_peer",
				"relay",
				"--generation",
				"old",
				"--stay-alive",
			]),
		).toEqual(["/repo/dist/cli.js", "_peer", "relay", "--stay-alive"]);
	});

	it("uses a slower lease heartbeat with an explicit takeover bound", async () => {
		const lock = vi.spyOn(lockfile, "lock").mockResolvedValue(async () => undefined);
		try {
			await acquirePeerRelayLock("/tmp/messages.db", "root@example:23915", () => undefined);
			expect(lock).toHaveBeenCalledWith(
				"/tmp/messages.db",
				expect.objectContaining({
					realpath: false,
					stale: PEER_RELAY_LOCK_STALE_MS,
					update: PEER_RELAY_LOCK_UPDATE_MS,
					retries: 0,
					lockfilePath: peerRelayLockPath("/tmp/messages.db", "root@example:23915"),
				}),
			);
			expect(PEER_RELAY_LOCK_UPDATE_MS).toBeLessThan(30_000);
			expect(PEER_RELAY_LOCK_MAX_TAKEOVER_MS).toBe(60_000);
		} finally {
			lock.mockRestore();
		}
	});

	it("does not steal a live owner lock, including from a legacy 30-second checker", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peer-relay-lock-live-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = "root@example:23915";
		const release = await acquirePeerRelayLock(dbPath, endpointId, () => undefined);
		try {
			expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(true);
			expect(
				lockfile.checkSync(dbPath, {
					realpath: false,
					lockfilePath: peerRelayLockPath(dbPath, endpointId),
					stale: 30_000,
				}),
			).toBe(true);
			await expect(acquirePeerRelayLock(dbPath, endpointId, () => undefined)).rejects.toMatchObject({
				code: "ELOCKED",
			});
		} finally {
			await release();
		}
		expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(false);
	});

	it("recovers a lock whose heartbeat is older than the configured stale window", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peer-relay-lock-stale-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = "root@example:23915";
		const lockPath = peerRelayLockPath(dbPath, endpointId);
		mkdirSync(lockPath);
		const staleAt = new Date(Date.now() - PEER_RELAY_LOCK_STALE_MS - 1_000);
		utimesSync(lockPath, staleAt, staleAt);
		expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(false);

		const release = await acquirePeerRelayLock(dbPath, endpointId, () => undefined);
		try {
			expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(true);
		} finally {
			await release();
		}
		expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(false);
	});
});
