/**
 * Peer message store: a shared SQLite database that agent sessions use to pass
 * plain-text messages to each other, plus a presence table so a recipient can
 * tell whether a sender is still around to receive a reply.
 *
 * The message-delivery kernel is ported faithfully from MinionsOS2's
 * `eacn3::messages` (Rust). Each `send` inserts one unread row addressed to one
 * recipient; each `drainUnread` atomically claims matching rows as `pending`.
 * The caller confirms them as `read` only after durable context injection, or
 * requeues/reclaims them after failure, providing at-least-once delivery.
 *
 * The `presence` table is a Magenta addition on top of that kernel: every agent
 * records whether it is `active` (in an agent loop), `idle` (process alive, not
 * looping), or `offline` (cleanly shut down), along with its owning process's
 * pid, per-process boot id, and random wake-socket capability. Liveness is
 * probed from the pid (`kill(pid, 0)`) rather than a heartbeat. Wake requests
 * connect to the boot-scoped Unix socket / named pipe instead of signalling the
 * pid, so stale presence cannot terminate a PID-reused process. When messages
 * are drained they are enriched with the *sender's* presence at that moment, so
 * a recipient can decide whether a reply will reach anyone.
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
import { DEFAULT_PEER_LINK_HOPS } from "./peer-link-protocol.ts";
import { DatabaseSync } from "./sqlite-adapter.ts";

/** Liveness of an agent, as recorded in the `presence` table. */
export type PresenceState = "active" | "idle" | "offline";

/** Message priority: urgent injects mid-loop, normal at loop end. */
export type MessagePriority = "urgent" | "normal";

/** Structured metadata carried end-to-end with a peer message. */
export type PeerMessageMetadata = Record<string, unknown>;

/** Reserved metadata used to persist the peer-link envelope between relay hops. */
export const PEER_FEDERATION_METADATA_KEY = "_magentaPeerFederation";

/** A transport-neutral federated message. Relays preserve every field. */
export type FederatedMessageEnvelope = {
	id: string;
	sender: string;
	recipient: string;
	content: string;
	createdAt: string;
	priority: MessagePriority;
	metadata?: PeerMessageMetadata;
};

export type PeerRoute = {
	sessionId: string;
	peerStoreId: string;
	updatedAt: string;
};

export type PeerOutboxStatus = "pending" | "inflight" | "forwarded";
export type PeerDeliveryStatus = "pending" | "inflight" | "forwarded";

/** One durable outbox row, including the original transport envelope. */
export type PeerOutboxMessage = FederatedMessageEnvelope & {
	targetPeerStoreId: string | null;
	receivedAt: string;
};

/** Per-link delivery tracking row. */
export type PeerDeliveryRecord = {
	messageId: string;
	peerStoreId: string;
	status: PeerDeliveryStatus;
	claimOwner?: string;
	claimedAt?: string;
};

export type RoutedSendResult = {
	id: string;
	createdAt: string;
	disposition: "local" | "peer" | "unresolved";
	peerStoreId?: string;
};

export type FederatedAcceptResult = {
	id: string;
	disposition: "local" | "relay" | "duplicate" | "not_found";
	peerStoreId?: string;
};

export type PeerOutboxCounts = {
	pending: number;
	inflight: number;
	forwarded: number;
	/** Pending rows for which no peer route was known at send time. */
	unresolved: number;
};

export type PeerEndpointDesiredState = "on" | "off";
export type PeerEndpointObservedState = "closed" | "connecting" | "connected" | "reconnecting" | "closing" | "error";

export type PeerEndpoint = {
	id: string;
	remote: string;
	port?: number;
	desiredState: PeerEndpointDesiredState;
	observedState: PeerEndpointObservedState;
	remoteStoreId?: string;
	relayPid?: number;
	relayBootId?: string;
	lastError?: string;
	updatedAt: string;
};

export type MessageStoreOptions = {
	stalenessMs?: number;
	/** Reclaim bridge claims older than this after relay process crashes. */
	peerOutboxClaimTimeoutMs?: number;
	/** Retention period for peer outbox messages (milliseconds). Default 7 days. */
	peerOutboxRetentionMs?: number;
	/**
	 * Deduplication retention for `peer_seen`. Defaults to outbox retention times
	 * the V1 hop budget and cannot be configured below that delayed-flood window.
	 */
	peerSeenRetentionMs?: number;
	/** Optional fixed id for a new store. Must match when reopening it. */
	storeId?: string;
};

/** A snapshot of one agent's presence, as seen at read time. */
export type Presence = {
	/** Last explicitly-recorded state. */
	state: PresenceState;
	/** RFC3339 timestamp of the last heartbeat / state change. */
	lastSeen: string;
	/**
	 * Effective online flag computed at read time: true when the row is not
	 * offline and its recorded pid currently exists. Wake safety does not rely on
	 * this hint; it uses the boot-scoped socket capability below.
	 */
	online: boolean;
	/** Process ID of the agent, when it's running. Null when offline. */
	pid: number | null;
	/** Random identifier for the process instance that owns this presence row. */
	bootId: string | null;
	/** Per-process Unix socket / named-pipe capability used for safe mailbox wake. */
	wakePath: string | null;
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
	/** Optional structured data preserved across local and federated delivery. */
	metadata?: PeerMessageMetadata;
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
/** Default retention period for peer outbox messages (7 days). */
const DEFAULT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'unread',
    drained_at TEXT,
    claim_owner TEXT,
    claim_pid   INTEGER,
    priority   TEXT NOT NULL DEFAULT 'normal',
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, status);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages(created_at);

CREATE TABLE IF NOT EXISTS presence (
    agent_id   TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    pid        INTEGER,
    boot_id    TEXT,
    wake_path  TEXT
);

CREATE TABLE IF NOT EXISTS store_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    store_id  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS peer_routes (
    session_id   TEXT PRIMARY KEY,
    peer_store_id TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peer_routes_store ON peer_routes(peer_store_id, session_id);

CREATE TABLE IF NOT EXISTS peer_outbox (
    message_id           TEXT PRIMARY KEY,
    sender               TEXT NOT NULL,
    recipient            TEXT NOT NULL,
    content              TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    priority             TEXT NOT NULL DEFAULT 'normal',
    metadata_json        TEXT,
    target_peer_store_id TEXT,
    -- Legacy global delivery columns remain for rollback/read compatibility.
    -- Gossip uses peer_outbox_delivery for new claims.
    status               TEXT NOT NULL DEFAULT 'pending',
    claim_owner          TEXT,
    claimed_at           TEXT,
    forwarded_at         TEXT,
    next_attempt_at      TEXT,
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    received_at          TEXT NOT NULL DEFAULT ''
);
-- NOTE: the legacy claim and retention indexes are created in migrate() after
-- every compatibility column exists.
-- The idx_peer_outbox_retention index on received_at is created in
-- migrate(), NOT here. On an existing database, CREATE TABLE IF NOT EXISTS is a
-- no-op and the pre-gossip peer_outbox has no received_at column, so creating
-- the index here would fail ("no such column: received_at") and abort the whole
-- SCHEMA batch before migrate() can ALTER the column in. migrate() adds the
-- column first, then creates this index, so both fresh and upgraded DBs work.

CREATE TABLE IF NOT EXISTS peer_outbox_delivery (
    message_id      TEXT NOT NULL,
    peer_store_id   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    claim_owner     TEXT,
    claimed_at      TEXT,
    PRIMARY KEY (message_id, peer_store_id)
);
CREATE INDEX IF NOT EXISTS idx_peer_outbox_delivery_claim
    ON peer_outbox_delivery(peer_store_id, status);

CREATE TABLE IF NOT EXISTS peer_endpoints (
    endpoint_id      TEXT PRIMARY KEY,
    remote           TEXT NOT NULL,
    port             INTEGER,
    desired_state    TEXT NOT NULL DEFAULT 'on',
    observed_state   TEXT NOT NULL DEFAULT 'closed',
    remote_store_id  TEXT,
    relay_pid        INTEGER,
    relay_boot_id    TEXT,
    last_error       TEXT,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peer_seen (
    message_id            TEXT PRIMARY KEY,
    first_seen_at         TEXT NOT NULL,
    ingress_peer_store_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_peer_seen_retention ON peer_seen(first_seen_at);
`;

/**
 * Message delivery + presence backed by a shared SQLite database.
 *
 * Multiple independent pi processes open their own `MessageStore` over the same
 * database file. Cross-process correctness relies on two things ported from
 * MinionsOS2:
 *  - WAL mode, so a reader never blocks a writer and vice versa.
 *  - A single `UPDATE ... RETURNING` drain (with an ordered subquery when capped),
 *    so no message inserted concurrently with a drain can be claimed without
 *    being returned (the classic SELECT-then-UPDATE race window is closed).
 */
export class MessageStore {
	private readonly db: InstanceType<typeof DatabaseSync>;
	private readonly stalenessMs: number;
	private readonly peerOutboxClaimTimeoutMs: number;
	private readonly peerOutboxRetentionMs: number;
	private readonly peerSeenRetentionMs: number;
	/** Stable identity persisted in the database and advertised to peer stores. */
	readonly storeId: string;

	constructor(dbPath: string, options?: MessageStoreOptions) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		// WAL: concurrent readers/writers across separate agent processes.
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);
		this.migrate();
		this.storeId = this.loadOrCreateStoreId(options?.storeId);
		this.stalenessMs = options?.stalenessMs ?? DEFAULT_STALENESS_MS;
		this.peerOutboxClaimTimeoutMs = options?.peerOutboxClaimTimeoutMs ?? 30_000;
		this.peerOutboxRetentionMs = options?.peerOutboxRetentionMs ?? DEFAULT_OUTBOX_RETENTION_MS;
		if (!Number.isFinite(this.peerOutboxClaimTimeoutMs) || this.peerOutboxClaimTimeoutMs < 0) {
			this.db.close();
			throw new TypeError("peer outbox claim timeout must be a non-negative finite number");
		}
		if (!Number.isFinite(this.peerOutboxRetentionMs) || this.peerOutboxRetentionMs < 0) {
			this.db.close();
			throw new TypeError("peer outbox retention must be a non-negative finite number");
		}
		const minimumPeerSeenRetentionMs = this.peerOutboxRetentionMs * DEFAULT_PEER_LINK_HOPS;
		this.peerSeenRetentionMs = options?.peerSeenRetentionMs ?? minimumPeerSeenRetentionMs;
		if (!Number.isFinite(this.peerSeenRetentionMs) || this.peerSeenRetentionMs < minimumPeerSeenRetentionMs) {
			this.db.close();
			throw new TypeError(`peer seen retention must be a finite number at least ${minimumPeerSeenRetentionMs}ms`);
		}
	}

	/**
	 * Bring an older database up to the current schema. Columns are added
	 * incrementally as the feature set grew:
	 *  - `drained_at` + the `pending` status: added when delivery gained an
	 *    at-least-once guarantee (drain → inject → confirm).
	 *  - `claim_owner` + `claim_pid`: identify the exact process instance whose
	 *    in-memory queue owns a pending row, preventing live long turns from being
	 *    mistaken for abandoned work.
	 *  - `priority`: added for urgent vs normal message delivery.
	 *  - presence `pid` + `boot_id`: added for signal-based idle wake (a sender
	 *    signals an idle recipient's process to make it drain immediately).
	 *  - messages `metadata_json`: structured metadata preserved during delivery.
	 * Federation tables are created by {@link SCHEMA}; existing local message ids
	 * are also seeded into `peer_seen` so a message cannot loop back after upgrade.
	 * Each column is added only if missing. Existing `read` rows are terminal and
	 * left untouched.
	 */
	private migrate(): void {
		// BEGIN IMMEDIATE serializes concurrent process startups before either one
		// inspects table_info, and SQLite keeps the ALTER sequence atomic.
		this.transaction(() => {
			const msgCols = this.db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
			if (!msgCols.some((c) => c.name === "drained_at")) {
				this.db.exec(`ALTER TABLE messages ADD COLUMN drained_at TEXT`);
			}
			if (!msgCols.some((c) => c.name === "priority")) {
				this.db.exec(`ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
			}
			if (!msgCols.some((c) => c.name === "claim_owner")) {
				this.db.exec(`ALTER TABLE messages ADD COLUMN claim_owner TEXT`);
			}
			if (!msgCols.some((c) => c.name === "claim_pid")) {
				this.db.exec(`ALTER TABLE messages ADD COLUMN claim_pid INTEGER`);
			}
			if (!msgCols.some((c) => c.name === "metadata_json")) {
				this.db.exec(`ALTER TABLE messages ADD COLUMN metadata_json TEXT`);
			}
			const presCols = this.db.prepare(`PRAGMA table_info(presence)`).all() as Array<{ name: string }>;
			if (!presCols.some((c) => c.name === "pid")) {
				this.db.exec(`ALTER TABLE presence ADD COLUMN pid INTEGER`);
			}
			if (!presCols.some((c) => c.name === "boot_id")) {
				this.db.exec(`ALTER TABLE presence ADD COLUMN boot_id TEXT`);
			}
			if (!presCols.some((c) => c.name === "wake_path")) {
				this.db.exec(`ALTER TABLE presence ADD COLUMN wake_path TEXT`);
			}
			const outboxCols = this.db.prepare(`PRAGMA table_info(peer_outbox)`).all() as Array<{ name: string }>;
			if (!outboxCols.some((c) => c.name === "status")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
			}
			if (!outboxCols.some((c) => c.name === "claim_owner")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN claim_owner TEXT`);
			}
			if (!outboxCols.some((c) => c.name === "claimed_at")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN claimed_at TEXT`);
			}
			if (!outboxCols.some((c) => c.name === "forwarded_at")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN forwarded_at TEXT`);
			}
			if (!outboxCols.some((c) => c.name === "next_attempt_at")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN next_attempt_at TEXT`);
			}
			if (!outboxCols.some((c) => c.name === "attempt_count")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`);
			}
			this.db.exec(
				`CREATE INDEX IF NOT EXISTS idx_peer_outbox_claim ON peer_outbox(status, target_peer_store_id, priority, created_at);`,
			);
			// Gossip flooding migration: outbox rows gain a received_at for time-based GC,
			// and per-link delivery is tracked in a separate peer_outbox_delivery table.
			// Legacy status/claim columns on peer_outbox are left in place (unused) so an
			// older database opens without a destructive rewrite.
			if (!outboxCols.some((c) => c.name === "received_at")) {
				this.db.exec(`ALTER TABLE peer_outbox ADD COLUMN received_at TEXT NOT NULL DEFAULT ''`);
			}
			// Backfill received_at from created_at for any row still carrying the empty
			// default. Run UNCONDITIONALLY (not just when the column was just added):
			// under a mixed-version deployment an interim/old binary can INSERT into
			// peer_outbox without supplying received_at (getting the '' default), and a
			// later new-binary restart would otherwise skip these rows forever, leaking
			// them past GC. This idempotent backfill heals them on every startup.
			this.db.exec(`UPDATE peer_outbox SET received_at = created_at WHERE received_at = ''`);
			this.db.exec(`
			CREATE TABLE IF NOT EXISTS peer_outbox_delivery (
				message_id      TEXT NOT NULL,
				peer_store_id   TEXT NOT NULL,
				status          TEXT NOT NULL DEFAULT 'pending',
				claim_owner     TEXT,
				claimed_at      TEXT,
				PRIMARY KEY (message_id, peer_store_id)
			);
		`);
			this.db.exec(
				`CREATE INDEX IF NOT EXISTS idx_peer_outbox_delivery_claim ON peer_outbox_delivery(peer_store_id, status);`,
			);
			this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_outbox_retention ON peer_outbox(received_at);`);
			this.db.exec(`
				INSERT OR IGNORE INTO peer_seen (message_id, first_seen_at, ingress_peer_store_id)
				SELECT id, created_at, NULL FROM messages
			`);
		});
	}

	private loadOrCreateStoreId(requested?: string): string {
		const candidate = requested ?? `store:${randomUUID().replace(/-/g, "")}`;
		this.db.prepare(`INSERT OR IGNORE INTO store_identity (singleton, store_id) VALUES (1, ?)`).run(candidate);
		const persisted = this.db.prepare(`SELECT store_id FROM store_identity WHERE singleton = 1`).get() as {
			store_id: string;
		};
		if (requested !== undefined && requested !== persisted.store_id) {
			this.db.close();
			throw new Error(`MessageStore id mismatch: database is ${persisted.store_id}, requested ${requested}`);
		}
		return persisted.store_id;
	}

	/** Return the stable id persisted by this store. */
	getStoreId(): string {
		return this.storeId;
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private static serializeMetadata(metadata?: PeerMessageMetadata): string | null {
		if (metadata === undefined) return null;
		if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
			throw new TypeError("message metadata must be a JSON object");
		}
		const serialized = JSON.stringify(metadata);
		if (serialized === undefined) throw new TypeError("message metadata must be JSON serializable");
		return serialized;
	}

	private static parseMetadata(serialized: string | null): PeerMessageMetadata | undefined {
		if (serialized === null) return undefined;
		const parsed: unknown = JSON.parse(serialized);
		if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
			throw new Error("stored message metadata is not a JSON object");
		}
		return parsed as PeerMessageMetadata;
	}

	private recordSeen(id: string, seenAt: string, ingressPeerStoreId: string | null): boolean {
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO peer_seen (message_id, first_seen_at, ingress_peer_store_id)
				 VALUES (?, ?, ?)`,
			)
			.run(id, seenAt, ingressPeerStoreId) as { changes: number | bigint };
		return Number(result.changes) > 0;
	}

	private insertInbox(envelope: FederatedMessageEnvelope): boolean {
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO messages
				 (id, sender, recipient, content, created_at, status, priority, metadata_json)
				 VALUES (?, ?, ?, ?, ?, 'unread', ?, ?)`,
			)
			.run(
				envelope.id,
				envelope.sender,
				envelope.recipient,
				envelope.content,
				envelope.createdAt,
				envelope.priority,
				MessageStore.serializeMetadata(envelope.metadata),
			) as { changes: number | bigint };
		return Number(result.changes) > 0;
	}

	private insertOutbox(
		envelope: FederatedMessageEnvelope,
		targetPeerStoreId: string | null,
		ingressPeerStoreId?: string | null,
	): boolean {
		const receivedAt = new Date().toISOString();
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO peer_outbox
				 (message_id, sender, recipient, content, created_at, priority, metadata_json,
				  target_peer_store_id, received_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				envelope.id,
				envelope.sender,
				envelope.recipient,
				envelope.content,
				envelope.createdAt,
				envelope.priority,
				MessageStore.serializeMetadata(envelope.metadata),
				targetPeerStoreId,
				receivedAt,
			) as { changes: number | bigint };
		const inserted = Number(result.changes) > 0;
		// Pre-mark ingress peer as delivered to prevent echo.
		if (inserted && ingressPeerStoreId) {
			this.db
				.prepare(
					`INSERT OR IGNORE INTO peer_outbox_delivery
					 (message_id, peer_store_id, status)
					 VALUES (?, ?, 'forwarded')`,
				)
				.run(envelope.id, ingressPeerStoreId);
		}
		return inserted;
	}

	private createEnvelope(
		sender: string,
		recipient: string,
		content: string,
		priority: MessagePriority,
		metadata?: PeerMessageMetadata,
	): FederatedMessageEnvelope {
		return {
			id: `m:${randomUUID().replace(/-/g, "")}`,
			sender,
			recipient,
			content,
			createdAt: new Date().toISOString(),
			priority,
			...(metadata === undefined ? {} : { metadata }),
		};
	}

	/**
	 * Deliver one message to one recipient. Id and timestamp are
	 * system-generated; callers provide only sender, recipient, content, and an
	 * optional priority (defaults to `normal`). Returns the generated message id.
	 */
	send(
		sender: string,
		recipient: string,
		content: string,
		priority: MessagePriority = "normal",
		metadata?: PeerMessageMetadata,
	): string {
		const envelope = this.createEnvelope(sender, recipient, content, priority, metadata);
		this.transaction(() => {
			this.recordSeen(envelope.id, envelope.createdAt, null);
			this.insertInbox(envelope);
		});
		return envelope.id;
	}

	/**
	 * Atomically replace all session advertisements from one peer. Under pure
	 * gossip, this is retained for observability (the route table is no longer
	 * consulted for forwarding decisions), but session advertisement/sync still
	 * happens during handshake. Routes pointing to local sessions are filtered out.
	 */
	replacePeerRoutes(peerStoreId: string, sessionIds: readonly string[]): void {
		if (peerStoreId.length === 0) throw new TypeError("peer store id must not be empty");
		if (peerStoreId === this.storeId) throw new Error("a peer route cannot target the local store");
		const uniqueSessionIds = [...new Set(sessionIds)];
		if (uniqueSessionIds.some((sessionId) => sessionId.length === 0)) {
			throw new TypeError("peer session ids must not be empty");
		}
		const now = new Date().toISOString();
		this.transaction(() => {
			this.db.prepare(`DELETE FROM peer_routes WHERE peer_store_id = ?`).run(peerStoreId);
			const insert = this.db.prepare(
				`INSERT INTO peer_routes (session_id, peer_store_id, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
				 WHERE peer_routes.peer_store_id = excluded.peer_store_id`,
			);
			const isLocal = this.db.prepare(`SELECT 1 AS found FROM presence WHERE agent_id = ?`);
			for (const sessionId of uniqueSessionIds) {
				if (isLocal.get(sessionId)) continue;
				insert.run(sessionId, peerStoreId, now);
			}
		});
	}

	/** List known remote routes, optionally restricted to one peer store. */
	listPeerRoutes(peerStoreId?: string): PeerRoute[] {
		type Row = { session_id: string; peer_store_id: string; updated_at: string };
		const rows = (
			peerStoreId === undefined
				? this.db.prepare(`SELECT session_id, peer_store_id, updated_at FROM peer_routes ORDER BY session_id`).all()
				: this.db
						.prepare(
							`SELECT session_id, peer_store_id, updated_at FROM peer_routes
						 WHERE peer_store_id = ? ORDER BY session_id`,
						)
						.all(peerStoreId)
		) as Row[];
		return rows.map((row) => ({
			sessionId: row.session_id,
			peerStoreId: row.peer_store_id,
			updatedAt: row.updated_at,
		}));
	}

	/** All sessions registered locally through the presence table. */
	listRegisteredSessionIds(): string[] {
		const rows = this.db.prepare(`SELECT agent_id FROM presence ORDER BY agent_id`).all() as Array<{
			agent_id: string;
		}>;
		return rows.map((row) => row.agent_id);
	}

	/**
	 * All sessions advertisable to a given peer: local presence sessions plus
	 * sessions reachable through other peers. Excludes routes pointing back to
	 * the excluded peer to prevent reflection loops. If excludePeerStoreId is
	 * undefined, returns local sessions plus all peer routes (used for initial
	 * hello before peer identity is known).
	 */
	listAdvertisableSessions(excludePeerStoreId?: string): string[] {
		const local = this.listRegisteredSessionIds();
		const peerRoutes = excludePeerStoreId
			? (this.db
					.prepare(
						`SELECT DISTINCT session_id FROM peer_routes
						 WHERE peer_store_id != ? ORDER BY session_id`,
					)
					.all(excludePeerStoreId) as Array<{ session_id: string }>)
			: (this.db.prepare(`SELECT DISTINCT session_id FROM peer_routes ORDER BY session_id`).all() as Array<{
					session_id: string;
				}>);
		const localSet = new Set(local);
		// Keep locally-owned sessions first. PeerLinkSession may truncate a large
		// observational route advertisement to the V1 frame budget, and first-hop
		// sender ownership must never lose local sessions in favor of transitive ones.
		return [...local, ...peerRoutes.map((row) => row.session_id).filter((sessionId) => !localSet.has(sessionId))];
	}

	/**
	 * Route a newly-created message. A presence row establishes local ownership,
	 * regardless of its current online state. Otherwise the message is queued in
	 * the durable outbox with no target peer: pure gossip floods it to every
	 * connected relay link, so no route table lookup is needed and there is no
	 * "unresolved" state. Receiver-side `peer_seen` + `visitedStoreIds` converge it.
	 */
	sendRouted(
		sender: string,
		recipient: string,
		content: string,
		priority: MessagePriority = "normal",
		metadata?: PeerMessageMetadata,
	): RoutedSendResult {
		const envelope = this.createEnvelope(sender, recipient, content, priority, metadata);
		return this.transaction(() => {
			const local = this.db.prepare(`SELECT 1 AS found FROM presence WHERE agent_id = ?`).get(recipient) as
				| { found: number }
				| undefined;
			this.recordSeen(envelope.id, envelope.createdAt, null);
			if (local) {
				this.insertInbox(envelope);
				return { id: envelope.id, createdAt: envelope.createdAt, disposition: "local" };
			}
			// Locally-originated: no ingress peer, floods to all links.
			this.insertOutbox(envelope, null, null);
			return { id: envelope.id, createdAt: envelope.createdAt, disposition: "peer" };
		});
	}

	/**
	 * Accept one message received from a peer. Accepted ids are recorded in
	 * `peer_seen` in the same transaction as inbox/relay insertion. A known local
	 * recipient is delivered locally; a route to a different peer is relayed; an
	 * unknown recipient or a route back to ingress is rejected as not found.
	 */
	/**
	 * Accept one message received from a peer under pure gossip flooding. Accepted
	 * ids are recorded in `peer_seen` in the same transaction as inbox/relay
	 * insertion. Rules (no route table consulted):
	 *  1. already in `peer_seen` -> duplicate
	 *  2. local recipient -> deliver to inbox
	 *  3. otherwise -> queue in outbox for onward flooding, pre-marking the ingress
	 *     peer as already delivered so the message never echoes back the way it came
	 * Loop and TTL bounds (self in visitedStoreIds, hopsRemaining exhausted) are
	 * enforced by the transport layer before this is called.
	 */
	acceptFederatedMessage(envelope: FederatedMessageEnvelope, ingressPeerStoreId: string): FederatedAcceptResult {
		return this.transaction(() => {
			const seen = this.db.prepare(`SELECT 1 AS found FROM peer_seen WHERE message_id = ?`).get(envelope.id);
			if (seen) return { id: envelope.id, disposition: "duplicate" };

			const local = this.db.prepare(`SELECT 1 AS found FROM presence WHERE agent_id = ?`).get(envelope.recipient);

			if (!this.recordSeen(envelope.id, new Date().toISOString(), ingressPeerStoreId)) {
				return { id: envelope.id, disposition: "duplicate" };
			}
			if (local) {
				if (!this.insertInbox(envelope)) return { id: envelope.id, disposition: "duplicate" };
				return { id: envelope.id, disposition: "local" };
			}
			// Not local: flood onward. target=NULL; pre-mark ingress delivered to avoid echo.
			if (!this.insertOutbox(envelope, null, ingressPeerStoreId)) {
				return { id: envelope.id, disposition: "duplicate" };
			}
			return { id: envelope.id, disposition: "relay" };
		});
	}

	/**
	 * Atomically claim outbox messages not yet delivered to `peerStoreId`. Uses
	 * the per-link delivery ledger: returns messages that have no delivery row for
	 * this peer, or whose delivery row is stale (crashed relay). Creates/updates
	 * delivery rows to track inflight state per link. Pure gossip normally floods
	 * every message to every link. When `allowTransit` is false, the durable query
	 * claims only locally-originated first-hop rows; relayed rows get no delivery
	 * record and remain eligible after the peer upgrades its advertised capability.
	 * `includeUnresolved` is ignored (kept for compat).
	 */
	claimPeerOutbox(
		peerStoreId: string,
		owner: string,
		limit = 100,
		_includeUnresolved = false,
		options?: { allowTransit?: boolean },
	): PeerOutboxMessage[] {
		if (peerStoreId.length === 0 || owner.length === 0) {
			throw new TypeError("peer store id and claim owner must not be empty");
		}
		const normalizedLimit =
			Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : Number.MAX_SAFE_INTEGER;
		const nowMs = Date.now();
		const claimedAt = new Date(nowMs).toISOString();
		const staleBefore = new Date(nowMs - this.peerOutboxClaimTimeoutMs).toISOString();
		const transitPredicate =
			options?.allowTransit === false
				? `AND json_extract(o.metadata_json, '$.${PEER_FEDERATION_METADATA_KEY}.originStoreId') IS NULL`
				: "";
		type Row = {
			message_id: string;
			sender: string;
			recipient: string;
			content: string;
			created_at: string;
			priority: MessagePriority;
			metadata_json: string | null;
			target_peer_store_id: string | null;
			received_at: string;
		};
		const rows = this.transaction(() => {
			// Reclaim stale inflight delivery rows.
			this.db
				.prepare(
					`UPDATE peer_outbox_delivery SET status = 'pending', claim_owner = NULL, claimed_at = NULL
					 WHERE peer_store_id = ? AND status = 'inflight'
					   AND (claimed_at IS NULL OR claimed_at <= ?)`,
				)
				.run(peerStoreId, staleBefore);
			// Select messages not yet forwarded to this peer. Federation metadata is
			// absent on locally-originated rows and present on every accepted relay row.
			const candidates = this.db
				.prepare(
					`SELECT o.message_id, o.sender, o.recipient, o.content, o.created_at, o.priority,
					        o.metadata_json, o.target_peer_store_id, o.received_at
					 FROM peer_outbox o
					 LEFT JOIN peer_outbox_delivery d
					   ON o.message_id = d.message_id AND d.peer_store_id = ?
					 WHERE (d.status IS NULL OR d.status = 'pending')
					   ${transitPredicate}
					 ORDER BY (CASE o.priority WHEN 'urgent' THEN 0 ELSE 1 END), o.rowid
					 LIMIT ?`,
				)
				.all(peerStoreId, normalizedLimit) as Row[];
			// Mark them inflight in the delivery ledger.
			const upsert = this.db.prepare(
				`INSERT INTO peer_outbox_delivery (message_id, peer_store_id, status, claim_owner, claimed_at)
				 VALUES (?, ?, 'inflight', ?, ?)
				 ON CONFLICT(message_id, peer_store_id) DO UPDATE SET
				   status = 'inflight', claim_owner = excluded.claim_owner, claimed_at = excluded.claimed_at`,
			);
			for (const row of candidates) {
				upsert.run(row.message_id, peerStoreId, owner, claimedAt);
			}
			return candidates;
		});
		return rows.map((row) => {
			const metadata = MessageStore.parseMetadata(row.metadata_json);
			return {
				id: row.message_id,
				sender: row.sender,
				recipient: row.recipient,
				content: row.content,
				createdAt: row.created_at,
				priority: row.priority,
				targetPeerStoreId: row.target_peer_store_id,
				receivedAt: row.received_at,
				...(metadata === undefined ? {} : { metadata }),
			};
		});
	}

	/** Mark per-link delivery rows as durably forwarded. All ack statuses stop retry. */
	ackPeerOutbox(ids: readonly string[], owner: string): number {
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => "?").join(",");
		const result = this.db
			.prepare(
				`UPDATE peer_outbox_delivery SET status = 'forwarded', claim_owner = NULL, claimed_at = NULL
				 WHERE status = 'inflight' AND claim_owner = ? AND message_id IN (${placeholders})`,
			)
			.run(owner, ...ids) as { changes: number | bigint };
		return Number(result.changes);
	}

	/** Return per-link delivery rows to pending for retry. */
	requeuePeerOutbox(ids: readonly string[], owner: string, options?: { notFound?: boolean }): number {
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => "?").join(",");
		// Gossip: not_found means TTL/loop, not "wrong branch". Stop retry on that link.
		if (options?.notFound) {
			const result = this.db
				.prepare(
					`UPDATE peer_outbox_delivery SET status = 'forwarded', claim_owner = NULL, claimed_at = NULL
					 WHERE status = 'inflight' AND claim_owner = ? AND message_id IN (${placeholders})`,
				)
				.run(owner, ...ids) as { changes: number | bigint };
			return Number(result.changes);
		}
		const result = this.db
			.prepare(
				`UPDATE peer_outbox_delivery SET status = 'pending', claim_owner = NULL, claimed_at = NULL
				 WHERE status = 'inflight' AND claim_owner = ? AND message_id IN (${placeholders})`,
			)
			.run(owner, ...ids) as { changes: number | bigint };
		return Number(result.changes);
	}

	/**
	 * Status totals for the outbox. Under gossip there is no per-message status;
	 * `pending` counts messages still held in the outbox (the undelivered backlog),
	 * while `inflight`/`forwarded` aggregate the per-link delivery ledger. `unresolved`
	 * is always 0 (gossip has no unresolved state) and is kept for API compatibility.
	 */
	getPeerOutboxCounts(peerStoreId?: string): PeerOutboxCounts {
		const totalMessages = this.db.prepare(`SELECT COUNT(*) AS c FROM peer_outbox`).get() as { c: number };
		const deliveryStats = peerStoreId
			? (this.db
					.prepare(
						`SELECT
						   SUM(CASE WHEN status = 'inflight' THEN 1 ELSE 0 END) AS inflight,
						   SUM(CASE WHEN status = 'forwarded' THEN 1 ELSE 0 END) AS forwarded
						 FROM peer_outbox_delivery WHERE peer_store_id = ?`,
					)
					.get(peerStoreId) as { inflight: number | null; forwarded: number | null })
			: (this.db
					.prepare(
						`SELECT
						   SUM(CASE WHEN status = 'inflight' THEN 1 ELSE 0 END) AS inflight,
						   SUM(CASE WHEN status = 'forwarded' THEN 1 ELSE 0 END) AS forwarded
						 FROM peer_outbox_delivery`,
					)
					.get() as { inflight: number | null; forwarded: number | null });
		return {
			pending: totalMessages.c ?? 0,
			inflight: deliveryStats.inflight ?? 0,
			forwarded: deliveryStats.forwarded ?? 0,
			unresolved: 0,
		};
	}

	/** Register an SSH mailbox endpoint without changing an explicit manual-off choice. */
	upsertPeerEndpoint(id: string, remote: string, port?: number): PeerEndpoint {
		if (!id || !remote) throw new TypeError("peer endpoint id and remote must not be empty");
		if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
			throw new TypeError("peer endpoint port must be an integer from 1 to 65535");
		}
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO peer_endpoints
				 (endpoint_id, remote, port, desired_state, observed_state, updated_at)
				 VALUES (?, ?, ?, 'on', 'closed', ?)
				 ON CONFLICT(endpoint_id) DO UPDATE SET
				   remote = excluded.remote,
				   port = excluded.port,
				   updated_at = excluded.updated_at`,
			)
			.run(id, remote, port ?? null, now);
		return this.getPeerEndpoint(id)!;
	}

	getPeerEndpoint(id: string): PeerEndpoint | undefined {
		type Row = {
			endpoint_id: string;
			remote: string;
			port: number | null;
			desired_state: PeerEndpointDesiredState;
			observed_state: PeerEndpointObservedState;
			remote_store_id: string | null;
			relay_pid: number | null;
			relay_boot_id: string | null;
			last_error: string | null;
			updated_at: string;
		};
		const row = this.db
			.prepare(
				`SELECT endpoint_id, remote, port, desired_state, observed_state, remote_store_id,
				        relay_pid, relay_boot_id, last_error, updated_at
				   FROM peer_endpoints WHERE endpoint_id = ?`,
			)
			.get(id) as Row | undefined;
		if (!row) return undefined;
		return {
			id: row.endpoint_id,
			remote: row.remote,
			...(row.port === null ? {} : { port: row.port }),
			desiredState: row.desired_state,
			observedState: row.observed_state,
			...(row.remote_store_id === null ? {} : { remoteStoreId: row.remote_store_id }),
			...(row.relay_pid === null ? {} : { relayPid: row.relay_pid }),
			...(row.relay_boot_id === null ? {} : { relayBootId: row.relay_boot_id }),
			...(row.last_error === null ? {} : { lastError: row.last_error }),
			updatedAt: row.updated_at,
		};
	}

	listPeerEndpoints(): PeerEndpoint[] {
		const ids = this.db.prepare(`SELECT endpoint_id FROM peer_endpoints ORDER BY endpoint_id`).all() as Array<{
			endpoint_id: string;
		}>;
		return ids.map((row) => this.getPeerEndpoint(row.endpoint_id)!);
	}

	setPeerEndpointDesiredState(id: string, desiredState: PeerEndpointDesiredState): boolean {
		const result = this.db
			.prepare(`UPDATE peer_endpoints SET desired_state = ?, updated_at = ? WHERE endpoint_id = ?`)
			.run(desiredState, new Date().toISOString(), id) as { changes: number | bigint };
		return Number(result.changes) > 0;
	}

	/** Acquire the host-level relay slot, fencing stale or crashed owners by pid+boot id. */
	claimPeerEndpointRelay(id: string, pid: number, bootId: string): boolean {
		if (!Number.isInteger(pid) || pid <= 0 || !bootId) throw new TypeError("relay owner requires pid and boot id");
		return this.transaction(() => {
			const current = this.db
				.prepare(`SELECT desired_state, relay_pid, relay_boot_id FROM peer_endpoints WHERE endpoint_id = ?`)
				.get(id) as
				| {
						desired_state: PeerEndpointDesiredState;
						relay_pid: number | null;
						relay_boot_id: string | null;
				  }
				| undefined;
			if (!current || current.desired_state !== "on") return false;
			if (
				current.relay_pid !== null &&
				current.relay_boot_id !== bootId &&
				MessageStore.isProcessAlive(current.relay_pid)
			) {
				return false;
			}
			this.db
				.prepare(
					`UPDATE peer_endpoints SET relay_pid = ?, relay_boot_id = ?, observed_state = 'connecting',
					 last_error = NULL, updated_at = ? WHERE endpoint_id = ?`,
				)
				.run(pid, bootId, new Date().toISOString(), id);
			return true;
		});
	}

	updatePeerEndpointRelay(
		id: string,
		bootId: string,
		observedState: PeerEndpointObservedState,
		options?: { remoteStoreId?: string; lastError?: string },
	): boolean {
		const result = this.db
			.prepare(
				`UPDATE peer_endpoints SET observed_state = ?, remote_store_id = COALESCE(?, remote_store_id),
				 last_error = ?, updated_at = ? WHERE endpoint_id = ? AND relay_boot_id = ?`,
			)
			.run(
				observedState,
				options?.remoteStoreId ?? null,
				options?.lastError ?? null,
				new Date().toISOString(),
				id,
				bootId,
			) as { changes: number | bigint };
		return Number(result.changes) > 0;
	}

	releasePeerEndpointRelay(id: string, bootId: string, observedState: PeerEndpointObservedState = "closed"): boolean {
		const result = this.db
			.prepare(
				`UPDATE peer_endpoints SET relay_pid = NULL, relay_boot_id = NULL, observed_state = ?, updated_at = ?
				 WHERE endpoint_id = ? AND relay_boot_id = ?`,
			)
			.run(observedState, new Date().toISOString(), id, bootId) as { changes: number | bigint };
		return Number(result.changes) > 0;
	}

	/** Unique live Magenta process ids advertised by local session presence rows. */
	listLiveSessionPids(): number[] {
		const rows = this.db
			.prepare(`SELECT DISTINCT pid FROM presence WHERE state != 'offline' AND pid IS NOT NULL ORDER BY pid`)
			.all() as Array<{ pid: number }>;
		return rows.map((row) => row.pid).filter((pid) => MessageStore.isProcessAlive(pid));
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
	 *
	 * `limit` caps how many messages a single drain claims, so a large backlog is
	 * injected in bounded batches across successive loops instead of one oversized
	 * context block. Messages beyond the cap stay `unread` and are claimed by the
	 * next drain, in the same priority-then-FIFO order, so nothing is lost or
	 * reordered — the cap only bounds batch size, never drops a message. Omitting
	 * `limit` (or a non-positive/non-finite value) claims everything, preserving
	 * the original behaviour. SQLite does not support portable `UPDATE ... ORDER
	 * BY ... LIMIT`, so the capped path selects the ordered rowids inside the
	 * UPDATE's `IN` subquery. Claiming remains one atomic statement across the
	 * independent SQLite connections opened by different agent processes.
	 * When `claim` is supplied, confirm/requeue operations must present the same
	 * owner id. Stale recovery then keeps claims owned by the live current process
	 * in flight regardless of age, while abandoned owners remain recoverable.
	 */
	drainUnread(recipient: string, limit?: number, claim?: { ownerId: string; pid: number }): PeerMessage[] {
		// Recover any messages left `pending` by a previous drain whose injection
		// never confirmed (crash, thrown injector, interrupted turn). They rejoin
		// this claim so a transient failure cannot strand a message forever.
		this.reclaimStalePending(recipient);
		const drainedAt = new Date().toISOString();
		const normalizedLimit =
			typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined;

		type Row = {
			rowid: number;
			id: string;
			sender: string;
			recipient: string;
			content: string;
			created_at: string;
			priority: MessagePriority;
			metadata_json: string | null;
		};

		let rows: Row[];
		if (normalizedLimit !== undefined) {
			rows = this.db
				.prepare(
					`UPDATE messages SET status = 'pending', drained_at = ?, claim_owner = ?, claim_pid = ?
					 WHERE status = 'unread' AND rowid IN (
					   SELECT rowid FROM messages
					    WHERE recipient = ? AND status = 'unread'
					    ORDER BY (CASE priority WHEN 'urgent' THEN 0 ELSE 1 END), rowid
					    LIMIT ?
					 )
					 RETURNING rowid, id, sender, recipient, content, created_at, priority, metadata_json`,
				)
				.all(drainedAt, claim?.ownerId ?? null, claim?.pid ?? null, recipient, normalizedLimit) as Row[];
		} else {
			rows = this.db
				.prepare(
					`UPDATE messages SET status = 'pending', drained_at = ?, claim_owner = ?, claim_pid = ?
					 WHERE recipient = ? AND status = 'unread'
					 RETURNING rowid, id, sender, recipient, content, created_at, priority, metadata_json`,
				)
				.all(drainedAt, claim?.ownerId ?? null, claim?.pid ?? null, recipient) as Row[];
		}

		// Priority DESC (urgent before normal), then rowid ASC (FIFO within a priority).
		const ordered = rows.slice().sort((a, b) => {
			if (a.priority !== b.priority) return a.priority === "urgent" ? -1 : 1;
			return a.rowid - b.rowid;
		});
		return ordered.map((r) => {
			const metadata = MessageStore.parseMetadata(r.metadata_json);
			return {
				id: r.id,
				sender: r.sender,
				recipient: r.recipient,
				content: r.content,
				createdAt: r.created_at,
				priority: r.priority,
				...(metadata === undefined ? {} : { metadata }),
				senderPresence: this.getPresence(r.sender),
			};
		});
	}

	/**
	 * Confirm that the given messages were successfully injected into the
	 * recipient's context. Moves them from `pending` to the terminal `read`
	 * state so they are never redelivered. Ids not currently `pending` are
	 * ignored (idempotent). Owned claims are settled only by their matching owner;
	 * omitting `claimOwner` settles only legacy/unowned claims.
	 */
	markDelivered(ids: string[], claimOwner?: string): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(",");
		const ownerPredicate = claimOwner === undefined ? "claim_owner IS NULL" : "claim_owner = ?";
		this.db
			.prepare(
				`UPDATE messages SET status = 'read', drained_at = NULL, claim_owner = NULL, claim_pid = NULL
				 WHERE status = 'pending' AND ${ownerPredicate} AND id IN (${placeholders})`,
			)
			.run(...(claimOwner === undefined ? ids : [claimOwner, ...ids]));
	}

	/**
	 * Return the given messages to the `unread` state so the next drain redelivers
	 * them. Called when injection failed after a drain. Ids not currently
	 * `pending` are ignored (idempotent). Owned claims are requeued only by their
	 * matching owner; omitting `claimOwner` touches only legacy/unowned claims.
	 */
	requeue(ids: string[], claimOwner?: string): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(",");
		const ownerPredicate = claimOwner === undefined ? "claim_owner IS NULL" : "claim_owner = ?";
		this.db
			.prepare(
				`UPDATE messages SET status = 'unread', drained_at = NULL, claim_owner = NULL, claim_pid = NULL
				 WHERE status = 'pending' AND ${ownerPredicate} AND id IN (${placeholders})`,
			)
			.run(...(claimOwner === undefined ? ids : [claimOwner, ...ids]));
	}

	/**
	 * Return to `unread` stale pending messages whose claim owner is no longer the
	 * live process instance registered for this recipient. This preserves crash
	 * recovery without redelivering a message merely because a healthy model/tool
	 * turn ran longer than the time window. Legacy rows without an owner retain the
	 * historical time-only recovery rule.
	 */
	reclaimStalePending(recipient: string): void {
		const cutoff = new Date(Date.now() - this.stalenessMs).toISOString();
		// Legacy/unowned claims retain the historical time-only recovery rule.
		this.db
			.prepare(
				`UPDATE messages SET status = 'unread', drained_at = NULL, claim_owner = NULL, claim_pid = NULL
				 WHERE recipient = ? AND status = 'pending' AND claim_owner IS NULL
				   AND (drained_at IS NULL OR drained_at <= ?)`,
			)
			.run(recipient, cutoff);

		const presence = this.db.prepare(`SELECT state, pid, boot_id FROM presence WHERE agent_id = ?`).get(recipient) as
			| { state: PresenceState; pid: number | null; boot_id: string | null }
			| undefined;
		const claims = this.db
			.prepare(
				`SELECT DISTINCT claim_owner, claim_pid FROM messages
				 WHERE recipient = ? AND status = 'pending' AND claim_owner IS NOT NULL
				   AND (drained_at IS NULL OR drained_at <= ?)`,
			)
			.all(recipient, cutoff) as Array<{ claim_owner: string; claim_pid: number | null }>;

		for (const claim of claims) {
			const ownerStillCurrent =
				presence?.state !== "offline" &&
				presence?.boot_id === claim.claim_owner &&
				claim.claim_pid !== null &&
				(presence.pid === null || presence.pid === claim.claim_pid) &&
				MessageStore.isProcessAlive(claim.claim_pid);
			if (ownerStillCurrent) continue;
			this.db
				.prepare(
					`UPDATE messages SET status = 'unread', drained_at = NULL, claim_owner = NULL, claim_pid = NULL
					 WHERE recipient = ? AND status = 'pending' AND claim_owner = ? AND claim_pid IS ?
					   AND (drained_at IS NULL OR drained_at <= ?)`,
				)
				.run(recipient, claim.claim_owner, claim.claim_pid, cutoff);
		}
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
	 * `pid`/`bootId` identify the concrete process instance. `wakePath` is a
	 * random per-process Unix socket or named-pipe capability; unlike a POSIX
	 * signal, a stale path cannot terminate an unrelated PID-reused process.
	 * On a clean `offline` transition all three fields are cleared.
	 */
	updatePresence(
		agentId: string,
		state: PresenceState,
		opts?: { pid?: number | null; bootId?: string | null; wakePath?: string | null },
	): void {
		const now = new Date().toISOString();
		const pid = state === "offline" ? null : (opts?.pid ?? null);
		const bootId = state === "offline" ? null : (opts?.bootId ?? null);
		const wakePath = state === "offline" ? null : (opts?.wakePath ?? null);
		this.db
			.prepare(
				`INSERT INTO presence (agent_id, state, last_seen, pid, boot_id, wake_path) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET
				   state = excluded.state,
				   last_seen = excluded.last_seen,
				   pid = excluded.pid,
				   boot_id = excluded.boot_id,
				   wake_path = excluded.wake_path`,
			)
			.run(agentId, state, now, pid, bootId, wakePath);
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
			.prepare(`SELECT state, last_seen, pid, boot_id, wake_path FROM presence WHERE agent_id = ?`)
			.get(agentId) as
			| {
					state: PresenceState;
					last_seen: string;
					pid: number | null;
					boot_id: string | null;
					wake_path: string | null;
			  }
			| undefined;
		if (!row) return undefined;
		const alive = row.pid != null && MessageStore.isProcessAlive(row.pid);
		return {
			state: row.state,
			lastSeen: row.last_seen,
			online: row.state !== "offline" && alive,
			pid: row.pid,
			bootId: row.boot_id,
			wakePath: row.wake_path,
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
	 * reused. It is only a liveness hint; mailbox wake uses a random boot-scoped
	 * socket capability and never sends a signal to this pid.
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

	/**
	 * Garbage-collect peer outbox messages older than the configured retention
	 * period. A gossip hub never learns that "all peers received" a message, so
	 * time-based retention is the only safe bound. The retention window is kept
	 * long (default 7 days) so an offline recipient can still be served after a
	 * multi-day absence. Delivery ledger rows are deleted alongside their message.
	 * Returns the number of messages purged.
	 */
	purgeExpiredOutbox(nowMs: number = Date.now()): number {
		const cutoff = new Date(nowMs - this.peerOutboxRetentionMs).toISOString();
		return this.transaction(() => {
			// Under a mixed-version deployment an interim/old binary may INSERT a row
			// without received_at (empty '' default). Fall back to created_at for those
			// rows so GC still reclaims them without waiting for a new-binary restart to
			// backfill (Fix A heals on restart; this makes GC tolerant meanwhile).
			const expired = this.db
				.prepare(
					`SELECT message_id FROM peer_outbox
					 WHERE (CASE WHEN received_at = '' THEN created_at ELSE received_at END) <= ?`,
				)
				.all(cutoff) as Array<{ message_id: string }>;
			if (expired.length === 0) return 0;
			const deleteDelivery = this.db.prepare(`DELETE FROM peer_outbox_delivery WHERE message_id = ?`);
			const deleteOutbox = this.db.prepare(`DELETE FROM peer_outbox WHERE message_id = ?`);
			for (const row of expired) {
				deleteDelivery.run(row.message_id);
				deleteOutbox.run(row.message_id);
			}
			return expired.length;
		});
	}

	/**
	 * Garbage-collect deduplication markers after the maximum delayed-flood
	 * window. By default that is two outbox retention periods: one queue delay per
	 * V1 hop. A marker whose outbox body is still active is retained regardless of
	 * timestamp; maintenance deletes outbox bodies first, then calls this method.
	 * Inbox rows need no such exception because their primary key still rejects a
	 * replay and atomically recreates the marker.
	 */
	purgeExpiredPeerSeen(nowMs: number = Date.now()): number {
		const cutoff = new Date(nowMs - this.peerSeenRetentionMs).toISOString();
		const result = this.db
			.prepare(
				`DELETE FROM peer_seen
				 WHERE first_seen_at <= ?
				   AND NOT EXISTS (
				     SELECT 1 FROM peer_outbox
				      WHERE peer_outbox.message_id = peer_seen.message_id
				   )`,
			)
			.run(cutoff) as { changes: number | bigint };
		return Number(result.changes);
	}

	close(): void {
		this.db.close();
	}
}
