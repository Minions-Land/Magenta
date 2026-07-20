/**
 * Real old-database upgrade test for the gossip-flooding migration.
 *
 * Regression guard for the release blocker where a freshly built binary failed
 * to open an existing ~/.magenta/messages.db with:
 *   "HcpClient tool assembly failed: ... no such column: received_at"
 *
 * Root cause: the retention index `idx_peer_outbox_retention ON peer_outbox(received_at)`
 * used to live in the SCHEMA constant. On a pre-gossip database, `CREATE TABLE
 * IF NOT EXISTS peer_outbox` is a no-op (the table exists without received_at),
 * so `CREATE INDEX ... (received_at)` failed and aborted the whole SCHEMA batch
 * before migrate() could ALTER the column in. The fix moves that index creation
 * into migrate(), after the ALTER TABLE ... ADD COLUMN received_at.
 *
 * This test constructs a database with the pre-gossip peer_outbox shape (no
 * received_at, no peer_outbox_delivery), seeds a legacy outbox row, then opens
 * it with `new MessageStore(path)` and asserts the upgrade succeeds and data is
 * preserved.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import { DatabaseSync } from "../../tools/send-message/magenta/sqlite-adapter.ts";

describe("legacy schema upgrade (gossip migration)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function seedLegacyDb(): string {
		const dir = mkdtempSync(join(tmpdir(), "legacy-upgrade-"));
		dirs.push(dir);
		const path = join(dir, "messages.db");
		const db = new DatabaseSync(path);
		db.exec("PRAGMA journal_mode = WAL;");
		// Pre-gossip core tables. These mirror the shipped pre-gossip schema:
		// messages + presence + store_identity + peer_seen + a peer_outbox that
		// has the OLD per-row status/claim columns but NO received_at, and NO
		// peer_outbox_delivery table at all.
		db.exec(`
			CREATE TABLE messages (
				id           TEXT PRIMARY KEY,
				sender       TEXT NOT NULL,
				recipient    TEXT NOT NULL,
				content      TEXT NOT NULL,
				created_at   TEXT NOT NULL,
				status       TEXT NOT NULL DEFAULT 'unread'
			);
			CREATE TABLE presence (
				agent_id   TEXT PRIMARY KEY,
				state      TEXT NOT NULL,
				last_seen  TEXT NOT NULL
			);
			CREATE TABLE store_identity (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				store_id  TEXT NOT NULL UNIQUE
			);
			CREATE TABLE peer_seen (
				message_id            TEXT PRIMARY KEY,
				first_seen_at         TEXT NOT NULL,
				ingress_peer_store_id TEXT
			);
			CREATE TABLE peer_outbox (
				message_id           TEXT PRIMARY KEY,
				sender               TEXT NOT NULL,
				recipient            TEXT NOT NULL,
				content              TEXT NOT NULL,
				created_at           TEXT NOT NULL,
				priority             TEXT NOT NULL DEFAULT 'normal',
				metadata_json        TEXT,
				target_peer_store_id TEXT,
				status               TEXT NOT NULL DEFAULT 'pending',
				claim_owner          TEXT,
				claimed_at           TEXT,
				forwarded_at         TEXT,
				next_attempt_at      TEXT,
				attempt_count        INTEGER NOT NULL DEFAULT 0
			);
		`);
		// Fix the store identity so we can assert it is preserved across upgrade.
		db.prepare(`INSERT INTO store_identity (singleton, store_id) VALUES (1, ?)`).run("store:legacy-hub");
		// A legacy inbox message (unread) — must survive upgrade.
		db.prepare(
			`INSERT INTO messages (id, sender, recipient, content, created_at, status) VALUES (?, ?, ?, ?, ?, 'unread')`,
		).run("m:legacy-inbox", "alice", "local-sesh", "old inbox message", "2026-07-10T00:00:00.000Z");
		// A legacy queued outbox message (no received_at column value at all).
		db.prepare(
			`INSERT INTO peer_outbox (message_id, sender, recipient, content, created_at, priority, status)
			 VALUES (?, ?, ?, ?, ?, 'urgent', 'pending')`,
		).run("m:legacy-outbox", "alice", "haofeng", "queued before upgrade", "2026-07-11T00:00:00.000Z");
		db.close();
		return path;
	}

	it("opens a pre-gossip database, auto-migrates, and preserves legacy data", () => {
		const path = seedLegacyDb();

		// This is the exact call that failed before the fix: opening an existing
		// pre-gossip DB must run SCHEMA + migrate() without "no such column".
		const store = new MessageStore(path);
		try {
			// Store identity preserved.
			expect(store.getStoreId()).toBe("store:legacy-hub");

			// Legacy inbox message survives and is still drainable.
			const drained = store.drainUnread("local-sesh");
			expect(drained).toHaveLength(1);
			expect(drained[0].id).toBe("m:legacy-inbox");
			expect(drained[0].content).toBe("old inbox message");

			// Legacy outbox row survives and is claimable under gossip: it should be
			// counted as pending and a fresh link can claim it.
			expect(store.getPeerOutboxCounts().pending).toBe(1);
			const claimed = store.claimPeerOutbox("store:haofeng-leaf", "relay", 10);
			expect(claimed).toHaveLength(1);
			expect(claimed[0].id).toBe("m:legacy-outbox");
			expect(claimed[0].content).toBe("queued before upgrade");
		} finally {
			store.close();
		}
	});

	it("backfills received_at from created_at so legacy rows remain GC-able", () => {
		const path = seedLegacyDb();
		const store = new MessageStore(path, { peerOutboxRetentionMs: 7 * 24 * 60 * 60 * 1000 });
		try {
			// The legacy row was created 2026-07-11. received_at was backfilled from
			// created_at, so GC using a "now" far in the future purges it.
			const farFuture = Date.parse("2026-08-01T00:00:00.000Z");
			expect(store.purgeExpiredOutbox(farFuture)).toBe(1);
			expect(store.getPeerOutboxCounts().pending).toBe(0);
		} finally {
			store.close();
		}
	});

	it("creates the delivery table and retention index on upgrade", () => {
		const path = seedLegacyDb();
		const store = new MessageStore(path);
		try {
			// Poke the raw DB to confirm the migration artifacts exist. We reopen
			// read-only via a second handle to avoid touching the store internals.
			const probe = new DatabaseSync(path);
			try {
				const tables = probe
					.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='peer_outbox_delivery'`)
					.all() as Array<{ name: string }>;
				expect(tables).toHaveLength(1);

				const cols = probe.prepare(`PRAGMA table_info(peer_outbox)`).all() as Array<{ name: string }>;
				expect(cols.some((c) => c.name === "received_at")).toBe(true);

				const idx = probe
					.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_peer_outbox_retention'`)
					.all() as Array<{ name: string }>;
				expect(idx).toHaveLength(1);
			} finally {
				probe.close();
			}
		} finally {
			store.close();
		}
	});

	it("keeps legacy outbox columns in a fresh database for rollback compatibility", () => {
		const dir = mkdtempSync(join(tmpdir(), "fresh-rollback-schema-"));
		dirs.push(dir);
		const path = join(dir, "messages.db");
		const store = new MessageStore(path);
		try {
			const probe = new DatabaseSync(path);
			try {
				const names = new Set(
					(probe.prepare(`PRAGMA table_info(peer_outbox)`).all() as Array<{ name: string }>).map(
						(column) => column.name,
					),
				);
				for (const name of [
					"status",
					"claim_owner",
					"claimed_at",
					"forwarded_at",
					"next_attempt_at",
					"attempt_count",
				]) {
					expect(names.has(name), name).toBe(true);
				}
			} finally {
				probe.close();
			}
		} finally {
			store.close();
		}
	});

	// Mixed-version deployment scenarios: an interim/old binary inserting without
	// received_at (empty '' default) must not leak rows past GC.
	it("idempotent backfill heals empty received_at on restart (Fix A)", () => {
		const path = seedLegacyDb();
		const s1 = new MessageStore(path, { peerOutboxRetentionMs: 1000 });
		s1.close();

		// Simulate an interim/old binary inserting without received_at ('' default).
		const raw = new DatabaseSync(path);
		raw.prepare(
			`INSERT INTO peer_outbox (message_id, sender, recipient, content, created_at, priority)
			 VALUES (?, ?, ?, ?, ?, 'urgent')`,
		).run("m:oldbinary", "alice", "haofeng", "old insert", "2020-01-01T00:00:00.000Z");
		const before = raw.prepare("SELECT received_at FROM peer_outbox WHERE message_id='m:oldbinary'").get() as {
			received_at: string;
		};
		expect(before.received_at).toBe("");
		raw.close();

		// New binary restarts: migrate() runs the unconditional backfill.
		const s2 = new MessageStore(path, { peerOutboxRetentionMs: 1000 });
		try {
			// The '' row is healed to created_at, making it GC-able.
			const healed = new DatabaseSync(path);
			const after = healed.prepare("SELECT received_at FROM peer_outbox WHERE message_id='m:oldbinary'").get() as {
				received_at: string;
			};
			expect(after.received_at).toBe("2020-01-01T00:00:00.000Z");
			healed.close();

			// Both ancient rows (2020 oldbinary + 2026-07-11 seed legacy-outbox) are now
			// older than the 1s retention window, so GC reclaims both.
			expect(s2.purgeExpiredOutbox(Date.now())).toBe(2);
			expect(s2.getPeerOutboxCounts().pending).toBe(0);
		} finally {
			s2.close();
		}
	});

	it("GC COALESCE fallback purges empty received_at without restart (Fix B)", () => {
		const path = seedLegacyDb();
		const s1 = new MessageStore(path, { peerOutboxRetentionMs: 1000 });
		s1.close();

		// Simulate an interim/old binary inserting without received_at ('' default).
		const raw = new DatabaseSync(path);
		raw.prepare(
			`INSERT INTO peer_outbox (message_id, sender, recipient, content, created_at, priority)
			 VALUES (?, ?, ?, ?, ?, 'urgent')`,
		).run("m:oldbinary2", "alice", "haofeng", "old insert 2", "2020-01-01T00:00:00.000Z");
		raw.close();

		// Reuse the SAME new-binary handle that already ran migrate() at s1 open time,
		// then insert a fresh '' row directly and GC without any further migrate().
		// This proves the GC query itself tolerates '' (Fix B), independent of Fix A.
		const s2 = new MessageStore(path, { peerOutboxRetentionMs: 1000 });
		try {
			// Force the row back to '' AFTER migrate() has run, so only the GC-time
			// COALESCE fallback can reclaim it (Fix A's startup backfill already passed).
			const poke = new DatabaseSync(path);
			poke.exec(`UPDATE peer_outbox SET received_at = '' WHERE message_id = 'm:oldbinary2'`);
			poke.close();

			// No restart / no re-migrate: GC still purges the '' row via COALESCE fallback.
			const purged = s2.purgeExpiredOutbox(Date.now());
			expect(purged).toBeGreaterThanOrEqual(1);
			const probe = new DatabaseSync(path);
			const gone = probe.prepare("SELECT message_id FROM peer_outbox WHERE message_id='m:oldbinary2'").get();
			expect(gone).toBeUndefined();
			probe.close();
		} finally {
			s2.close();
		}
	});
});
