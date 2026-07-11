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
 * looping), or `offline` (cleanly shut down), along with its owning process's
 * pid and a per-process boot id. Liveness is probed directly from the pid
 * (`kill(pid, 0)`) rather than a heartbeat, so a crashed agent reads as offline
 * the instant its process is gone. The pid also lets a sender wake an `idle`
 * recipient by signalling its process (SIGUSR1); the boot id guards that wake
 * against PID reuse. When messages are drained they are enriched with the
 * *sender's* presence at that moment, so a recipient can decide whether a reply
 * will reach anyone.
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
import { DatabaseSync } from "./sqlite-adapter.ts";

/** Liveness of an agent, as recorded in the `presence` table. */
export type PresenceState = "active" | "idle" | "offline";

/** Message priority: urgent injects mid-loop, normal at loop end. */
export type MessagePriority = "urgent" | "normal";

/** A snapshot of one agent's presence, as seen at read time. */
export type Presence = {
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
	/** Process ID of the agent, when it's running. Null when offline. */
	pid: number | null;
	/**
	 * Boot identifier: a random UUID generated on process start. Used to detect
	 * PID reuse — if a signal target's pid matches but boot_id differs, that pid
	 * has been reassigned to a different process instance.
	 */
	bootId: string | null;
};

/** One delivered message, enriched with the sender's presence at drain time. */
export type PeerMessage = {
	id: string;
	/** Sender agent id (a pi session id). */
	sender: string;
	/** Recipient agent id (a pi session id). */
	recipient: string;
	content: string;
	/** RFC3339 timestamp of insertion. */
	createdAt: string;
	/** Delivery priority. Urgent messages inject mid-loop; normal at loop end. */
	priority: MessagePriority;
	/**
	 * The sender's presence at the time this message was drained. Undefined when
	 * the sender never recorded any presence.
	 */
	senderPresence?: Presence;
};

/**
 * Heartbeat staleness window. A presence row whose heartbeat is older than this
 * is treated as offline regardless of its recorded state, so a crashed agent is
 * not reported as online forever. Kept comfortably larger than the pi-side
 * heartbeat interval.
 */
/**
 * Staleness window for reclaiming stuck `pending` messages. A message claimed by
 * a drain that never confirmed delivery (crash between drain and
 * markDelivered/requeue) is returned to `unread` once its claim is older than
 * this. Presence liveness no longer uses this window — it probes the process
 * directly via {@link MessageStore.isProcessAlive} — so this only bounds how long
 * a message can be stranded in `pending` after a mid-delivery crash.
 */
const DEFAULT_STALENESS_MS = 30_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'unread',
    drained_at TEXT,
    priority   TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, status);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages(created_at);

CREATE TABLE IF NOT EXISTS presence (
    agent_id   TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    pid        INTEGER,
    boot_id    TEXT
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
	private readonly db: InstanceType<typeof DatabaseSync>;
	private readonly stalenessMs: number;

	constructor(dbPath: string, options?: { stalenessMs?: number }) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		// WAL: concurrent readers/writers across separate agent processes.
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);
		this.migrate();
		this.stalenessMs = options?.stalenessMs ?? DEFAULT_STALENESS_MS;
	}

	/**
	 * Bring an older database up to the current schema. Columns are added
	 * incrementally as the feature set grew:
	 *  - `drained_at` + the `pending` status: added when delivery gained an
	 *    at-least-once guarantee (drain → inject → confirm).
	 *  - `priority`: added for urgent vs normal message delivery.
	 *  - presence `pid` + `boot_id`: added for signal-based idle wake (a sender
	 *    signals an idle recipient's process to make it drain immediately).
	 * Each column is added only if missing. Existing `read` rows are terminal and
	 * left untouched.
	 */
	private migrate(): void {
		const msgCols = this.db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
		if (!msgCols.some((c) => c.name === "drained_at")) {
			this.db.exec(`ALTER TABLE messages ADD COLUMN drained_at TEXT`);
		}
		if (!msgCols.some((c) => c.name === "priority")) {
			this.db.exec(`ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
		}
		const presCols = this.db.prepare(`PRAGMA table_info(presence)`).all() as Array<{ name: string }>;
		if (!presCols.some((c) => c.name === "pid")) {
			this.db.exec(`ALTER TABLE presence ADD COLUMN pid INTEGER`);
		}
		if (!presCols.some((c) => c.name === "boot_id")) {
			this.db.exec(`ALTER TABLE presence ADD COLUMN boot_id TEXT`);
		}
	}

	/**
	 * Deliver one message to one recipient. Id and timestamp are
	 * system-generated; callers provide only sender, recipient, content, and an
	 * optional priority (defaults to `normal`). Returns the generated message id.
	 */
	send(sender: string, recipient: string, content: string, priority: MessagePriority = "normal"): string {
		const id = `m:${randomUUID().replace(/-/g, "")}`;
		const createdAt = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO messages (id, sender, recipient, content, created_at, status, priority)
				 VALUES (?, ?, ?, ?, ?, 'unread', ?)`,
			)
			.run(id, sender, recipient, content, createdAt, priority);
		return id;
	}

	/**
	 * Atomically claim this recipient's unread messages for delivery. Rows move
	 * from `unread` to `pending` (not straight to `read`) in a single statement,
	 * so no concurrently-inserted message can slip through the claim. Each claimed
	 * message is enriched with its sender's presence snapshot.
	 *
	 * `pending` is the in-flight state: a message has been handed to the caller
	 * but not yet confirmed as delivered into the agent's context. The caller MUST
	 * follow a successful injection with {@link markDelivered}; if injection fails
	 * it should call {@link requeue} (or simply do nothing and let
	 * {@link reclaimStalePending} recover it on a later drain). This drain → inject
	 * → confirm handshake turns the old fire-once delivery into at-least-once, so a
	 * message is never lost just because the injection step threw.
	 *
	 * `RETURNING` gives no ordering guarantee, so results are explicitly sorted
	 * by priority (urgent first) then rowid — the monotonic insertion order, which
	 * is the true global send order across processes even when several messages
	 * share a millisecond timestamp. This makes "the first thing an agent sees on
	 * entering its loop is every urgent message, then everything else that piled
	 * up while it was busy, in send order" exact.
	 */
	drainUnread(recipient: string): PeerMessage[] {
		// Recover any messages left `pending` by a previous drain whose injection
		// never confirmed (crash, thrown injector, interrupted turn). They rejoin
		// this claim so a transient failure cannot strand a message forever.
		this.reclaimStalePending(recipient);
		const drainedAt = new Date().toISOString();
		const rows = this.db
			.prepare(
				`UPDATE messages SET status = 'pending', drained_at = ?
				 WHERE recipient = ? AND status = 'unread'
				 RETURNING rowid, id, sender, recipient, content, created_at, priority`,
			)
			.all(drainedAt, recipient) as Array<{
			rowid: number;
			id: string;
			sender: string;
			recipient: string;
			content: string;
			created_at: string;
			priority: MessagePriority;
		}>;

		// Priority DESC (urgent before normal), then rowid ASC (FIFO within a priority).
		const ordered = rows.slice().sort((a, b) => {
			if (a.priority !== b.priority) return a.priority === "urgent" ? -1 : 1;
			return a.rowid - b.rowid;
		});
		return ordered.map((r) => ({
			id: r.id,
			sender: r.sender,
			recipient: r.recipient,
			content: r.content,
			createdAt: r.created_at,
			priority: r.priority,
			senderPresence: this.getPresence(r.sender),
		}));
	}

	/**
	 * Confirm that the given messages were successfully injected into the
	 * recipient's context. Moves them from `pending` to the terminal `read`
	 * state so they are never redelivered. Ids not currently `pending` are
	 * ignored (idempotent).
	 */
	markDelivered(ids: string[]): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(",");
		this.db
			.prepare(`UPDATE messages SET status = 'read' WHERE status = 'pending' AND id IN (${placeholders})`)
			.run(...ids);
	}

	/**
	 * Return the given messages to the `unread` state so the next drain redelivers
	 * them. Called when injection failed after a drain. Ids not currently
	 * `pending` are ignored (idempotent).
	 */
	requeue(ids: string[]): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(",");
		this.db
			.prepare(
				`UPDATE messages SET status = 'unread', drained_at = NULL WHERE status = 'pending' AND id IN (${placeholders})`,
			)
			.run(...ids);
	}

	/**
	 * Return to `unread` any of this recipient's messages that have been stuck in
	 * `pending` longer than the staleness window — i.e. a drain claimed them but no
	 * {@link markDelivered}/{@link requeue} ever followed (the classic
	 * crash-after-claim case). Reusing the presence staleness window keeps a
	 * single "how long before we assume a process is gone" knob.
	 */
	reclaimStalePending(recipient: string): void {
		const cutoff = new Date(Date.now() - this.stalenessMs).toISOString();
		this.db
			.prepare(
				`UPDATE messages SET status = 'unread', drained_at = NULL
				 WHERE recipient = ? AND status = 'pending' AND (drained_at IS NULL OR drained_at <= ?)`,
			)
			.run(recipient, cutoff);
	}

	/** Count unread messages for a recipient without consuming them. */
	unreadCount(recipient: string): number {
		const row = this.db
			.prepare(`SELECT COUNT(*) AS c FROM messages WHERE recipient = ? AND status = 'unread'`)
			.get(recipient) as { c: number };
		return row.c;
	}

	/**
	 * Record an agent's presence. Upserts state, records the owning process's pid
	 * and boot id, and stamps the update time. Called on state transitions
	 * (active/idle/offline). Unlike the old design there is no periodic heartbeat:
	 * liveness is probed directly from the pid at read time (see {@link getPresence}).
	 *
	 * `pid`/`bootId` identify the concrete process instance that currently owns
	 * this session, so a sender can signal it to wake and the recipient can reject
	 * a signal aimed at a stale pid that the OS has since reused. On a clean
	 * `offline` transition they are cleared.
	 */
	updatePresence(agentId: string, state: PresenceState, opts?: { pid?: number | null; bootId?: string | null }): void {
		const now = new Date().toISOString();
		const pid = state === "offline" ? null : (opts?.pid ?? null);
		const bootId = state === "offline" ? null : (opts?.bootId ?? null);
		this.db
			.prepare(
				`INSERT INTO presence (agent_id, state, last_seen, pid, boot_id) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET
				   state = excluded.state,
				   last_seen = excluded.last_seen,
				   pid = excluded.pid,
				   boot_id = excluded.boot_id`,
			)
			.run(agentId, state, now, pid, bootId);
	}

	/**
	 * Read an agent's presence, computing the effective `online` flag by probing
	 * the recorded pid directly (no heartbeat). Online means: not cleanly offline,
	 * a pid is recorded, and that pid is currently a live process. A crashed agent
	 * leaves a stale `active`/`idle` row whose pid is dead, so it reads as offline
	 * the instant its process is gone — more immediate and precise than a staleness
	 * window. Returns undefined when the agent has no record.
	 */
	getPresence(agentId: string): Presence | undefined {
		const row = this.db
			.prepare(`SELECT state, last_seen, pid, boot_id FROM presence WHERE agent_id = ?`)
			.get(agentId) as
			| { state: PresenceState; last_seen: string; pid: number | null; boot_id: string | null }
			| undefined;
		if (!row) return undefined;
		const alive = row.pid != null && MessageStore.isProcessAlive(row.pid);
		return {
			state: row.state,
			lastSeen: row.last_seen,
			online: row.state !== "offline" && alive,
			pid: row.pid,
			bootId: row.boot_id,
		};
	}

	/**
	 * Probe whether a pid is a currently-live process on this machine. Uses the
	 * POSIX signal-0 trick: `kill(pid, 0)` delivers nothing but performs the
	 * existence + permission check the kernel would do for a real signal.
	 *  - no throw  → process exists and is signalable → alive.
	 *  - ESRCH     → no such process → dead.
	 *  - EPERM     → process exists but owned by another user → alive for our
	 *                purposes (it is running; we just can't signal it).
	 * NOTE: this cannot distinguish the original process from a PID the OS has
	 * reused. Callers that act on the result (e.g. sending a wake signal) must also
	 * verify the boot id to guard against PID reuse.
	 */
	static isProcessAlive(pid: number): boolean {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "EPERM") return true;
			return false;
		}
	}

	close(): void {
		this.db.close();
	}
}
