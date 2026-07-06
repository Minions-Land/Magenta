/**
 * Peer message store: a shared SQLite database that agent sessions use to pass
 * plain-text messages to each other, plus a presence table so a recipient can
 * tell whether a sender is still around to receive a reply.
 *
 * The message-delivery kernel is ported faithfully from MinionsOS2's
 * `eacn3::messages` (Rust). Each `send` inserts one unread row addressed to one
 * recipient; each `drainUnread` returns and marks read that recipient's unread
 * rows in a single atomic statement. A consumed message is never redelivered.
 *
 * The `presence` table is a Magenta addition on top of that kernel: every agent
 * records whether it is `active` (in an agent loop), `idle` (process alive, not
 * looping), or `offline` (cleanly shut down), with a heartbeat timestamp. When
 * messages are drained they are enriched with the *sender's* presence at that
 * moment, so a recipient can decide whether a reply will reach anyone.
 *
 * Provenance:
 *   messages kernel — ported from MinionsOS2 (src/eacn3/messages.rs):
 *     messages(id, sender, recipient, content, created_at, status)
 *     + `UPDATE ... RETURNING` atomic drain. NOT original Magenta work.
 *   presence table + injection wiring — Magenta feature.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Liveness of an agent, as recorded in the `presence` table. */
export type PresenceState = "active" | "idle" | "offline";

/** A snapshot of one agent's presence, as seen at read time. */
export interface Presence {
	/** Last explicitly-recorded state. */
	state: PresenceState;
	/** RFC3339 timestamp of the last heartbeat / state change. */
	lastSeen: string;
	/**
	 * Effective online flag computed at read time: true when the agent is not
	 * offline AND its heartbeat is fresh. A crashed process leaves a stale
	 * `active`/`idle` row; staleness makes it read as offline.
	 */
	online: boolean;
}

/** One delivered message, enriched with the sender's presence at drain time. */
export interface PeerMessage {
	id: string;
	/** Sender agent id (a pi session id). */
	sender: string;
	/** Recipient agent id (a pi session id). */
	recipient: string;
	content: string;
	/** RFC3339 timestamp of insertion. */
	createdAt: string;
	/**
	 * The sender's presence at the time this message was drained. Undefined when
	 * the sender never recorded any presence.
	 */
	senderPresence?: Presence;
}

/**
 * Heartbeat staleness window. A presence row whose heartbeat is older than this
 * is treated as offline regardless of its recorded state, so a crashed agent is
 * not reported as online forever. Kept comfortably larger than the pi-side
 * heartbeat interval.
 */
const DEFAULT_STALENESS_MS = 30_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'unread'
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, status);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages(created_at);

CREATE TABLE IF NOT EXISTS presence (
    agent_id   TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    last_seen  TEXT NOT NULL
);
`;

/**
 * Message delivery + presence backed by a shared SQLite database.
 *
 * Multiple independent pi processes open their own `MessageStore` over the same
 * database file. Cross-process correctness relies on two things ported from
 * MinionsOS2:
 *  - WAL mode, so a reader never blocks a writer and vice versa.
 *  - A single `UPDATE ... RETURNING` drain, so no message inserted concurrently
 *    with a drain can be flipped to `read` without being returned (the classic
 *    SELECT-then-UPDATE race window is closed).
 */
export class MessageStore {
	private readonly db: DatabaseSync;
	private readonly stalenessMs: number;

	constructor(dbPath: string, options?: { stalenessMs?: number }) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		// WAL: concurrent readers/writers across separate agent processes.
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);
		this.stalenessMs = options?.stalenessMs ?? DEFAULT_STALENESS_MS;
	}

	/**
	 * Deliver one message to one recipient. Id and timestamp are
	 * system-generated; callers provide only sender, recipient, and content.
	 * Returns the generated message id.
	 */
	send(sender: string, recipient: string, content: string): string {
		const id = `m:${randomUUID().replace(/-/g, "")}`;
		const createdAt = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO messages (id, sender, recipient, content, created_at, status)
				 VALUES (?, ?, ?, ?, ?, 'unread')`,
			)
			.run(id, sender, recipient, content, createdAt);
		return id;
	}

	/**
	 * Read and consume all currently-unread messages for `recipient`, marking
	 * them read in the *same statement* so they are not redelivered and no
	 * concurrently-inserted message is lost. Each message is enriched with its
	 * sender's presence snapshot.
	 *
	 * `RETURNING` gives no ordering guarantee, so results are explicitly sorted
	 * by rowid — the monotonic insertion order, which is the true global send
	 * order across processes even when several messages share a millisecond
	 * timestamp. This makes "the first thing an agent sees on entering its loop
	 * is every message that piled up while it was busy, in send order" exact.
	 */
	drainUnread(recipient: string): PeerMessage[] {
		const rows = this.db
			.prepare(
				`UPDATE messages SET status = 'read'
				 WHERE recipient = ? AND status = 'unread'
				 RETURNING rowid, id, sender, recipient, content, created_at`,
			)
			.all(recipient) as Array<{
			rowid: number;
			id: string;
			sender: string;
			recipient: string;
			content: string;
			created_at: string;
		}>;

		const ordered = rows.slice().sort((a, b) => a.rowid - b.rowid);
		return ordered.map((r) => ({
			id: r.id,
			sender: r.sender,
			recipient: r.recipient,
			content: r.content,
			createdAt: r.created_at,
			senderPresence: this.getPresence(r.sender),
		}));
	}

	/** Count unread messages for a recipient without consuming them. */
	unreadCount(recipient: string): number {
		const row = this.db
			.prepare(`SELECT COUNT(*) AS c FROM messages WHERE recipient = ? AND status = 'unread'`)
			.get(recipient) as { c: number };
		return row.c;
	}

	/**
	 * Record an agent's presence. Upserts state and refreshes the heartbeat
	 * timestamp. Called both on state transitions (active/idle/offline) and as a
	 * periodic heartbeat with the current state to prove liveness.
	 */
	updatePresence(agentId: string, state: PresenceState): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO presence (agent_id, state, last_seen) VALUES (?, ?, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET state = excluded.state, last_seen = excluded.last_seen`,
			)
			.run(agentId, state, now);
	}

	/**
	 * Read an agent's presence, computing the effective `online` flag from the
	 * heartbeat freshness. Returns undefined when the agent has no record.
	 */
	getPresence(agentId: string): Presence | undefined {
		const row = this.db.prepare(`SELECT state, last_seen FROM presence WHERE agent_id = ?`).get(agentId) as
			| { state: PresenceState; last_seen: string }
			| undefined;
		if (!row) return undefined;
		const ageMs = Date.now() - new Date(row.last_seen).getTime();
		const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < this.stalenessMs;
		return {
			state: row.state,
			lastSeen: row.last_seen,
			online: row.state !== "offline" && fresh,
		};
	}

	close(): void {
		this.db.close();
	}
}
