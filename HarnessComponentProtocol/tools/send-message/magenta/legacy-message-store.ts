import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { MessageStore, PEER_FEDERATION_METADATA_KEY } from "./message-store.ts";
import { DEFAULT_PEER_LINK_HOPS } from "./peer-link-protocol.ts";
import { DatabaseSync } from "./sqlite-adapter.ts";

export type LegacyMessageStoreMigrationResult = {
	sourceMessages: number;
	insertedMessages: number;
	sourceOutbox: number;
	insertedOutbox: number;
	removedSource: boolean;
};

const EMPTY_RESULT: LegacyMessageStoreMigrationResult = {
	sourceMessages: 0,
	insertedMessages: 0,
	sourceOutbox: 0,
	insertedOutbox: 0,
	removedSource: false,
};

type JsonRecord = Record<string, unknown>;

type FederationMetadata = {
	originStoreId: string;
	visitedStoreIds: string[];
	hopsRemaining: number;
} & JsonRecord;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the reserved wire metadata without treating arbitrary user metadata as
 * federation state. Once a caller starts supplying the federation-shaped object,
 * malformed values fail closed so migration cannot silently create an undeliverable
 * relay row.
 */
function parseFederationMetadata(serialized: string | null): FederationMetadata | undefined {
	if (serialized === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new Error("legacy outbox metadata is not valid JSON");
	}
	if (!isRecord(parsed)) return undefined;
	const raw = parsed[PEER_FEDERATION_METADATA_KEY];
	if (raw === undefined || !isRecord(raw)) return undefined;
	const shaped = "originStoreId" in raw || "visitedStoreIds" in raw || "hopsRemaining" in raw;
	if (!shaped) return undefined;
	if (
		typeof raw.originStoreId !== "string" ||
		raw.originStoreId.length === 0 ||
		!Array.isArray(raw.visitedStoreIds) ||
		raw.visitedStoreIds.length === 0 ||
		raw.visitedStoreIds.length > DEFAULT_PEER_LINK_HOPS ||
		raw.visitedStoreIds.some((entry) => typeof entry !== "string" || entry.length === 0) ||
		!Number.isInteger(raw.hopsRemaining) ||
		(raw.hopsRemaining as number) < 0 ||
		(raw.hopsRemaining as number) > DEFAULT_PEER_LINK_HOPS
	) {
		throw new Error("legacy outbox federation metadata is invalid");
	}
	return {
		...raw,
		originStoreId: raw.originStoreId,
		visitedStoreIds: [...(raw.visitedStoreIds as string[])],
		hopsRemaining: raw.hopsRemaining as number,
	};
}

/**
 * Rebase the custody hop when an old mailbox is merged into the machine-global
 * store. The source and target ids represent the same local mailbox after the
 * move; retaining both would make a subsequent peer reject `previousHop` or
 * detect a self-loop. Other visited peers remain in their original order.
 */
function rebaseOutboxMetadata(
	serialized: string | null,
	sourceStoreId: string,
	targetStoreId: string,
): { metadata: string | null; federation?: FederationMetadata } {
	const federation = parseFederationMetadata(serialized);
	if (!federation) return { metadata: serialized };
	if (federation.visitedStoreIds.at(-1) !== sourceStoreId) {
		throw new Error("legacy outbox federation metadata does not end at the source store");
	}
	const parsed = JSON.parse(serialized!) as JsonRecord;
	const visitedWithoutMailbox = federation.visitedStoreIds.filter(
		(storeId) => storeId !== sourceStoreId && storeId !== targetStoreId,
	);
	const visitedStoreIds = [...visitedWithoutMailbox, targetStoreId];
	if (visitedStoreIds.length > DEFAULT_PEER_LINK_HOPS) {
		throw new Error("legacy outbox federation path exceeds the V1 hop budget after migration");
	}
	const rebasedFederation: FederationMetadata = {
		...federation,
		originStoreId: federation.originStoreId === sourceStoreId ? targetStoreId : federation.originStoreId,
		visitedStoreIds,
		hopsRemaining: federation.hopsRemaining,
	};
	return {
		metadata: JSON.stringify({
			...parsed,
			[PEER_FEDERATION_METADATA_KEY]: rebasedFederation,
		}),
		federation: rebasedFederation,
	};
}

function countRows(db: InstanceType<typeof DatabaseSync>, table: string, where = "1 = 1"): number {
	const row = db.prepare(`SELECT COUNT(*) AS count FROM legacy.${table} WHERE ${where}`).get() as { count: number };
	return row.count;
}

/**
 * Merge the pre-machine-global mailbox into the current store.
 *
 * Delivery-relevant state moves: unread inbox rows stay unread, abandoned inbox
 * claims are requeued, unsettled outbox payloads retain their per-link ledger,
 * and durable presence/endpoint configuration keeps routing ownership and the
 * user's desired relay state. Process ownership is always cleared. Terminal read
 * history is intentionally discarded. Target rows and durable import markers
 * commit first; only then does source-only settlement retire imported rows. This
 * order is crash-safe even though both databases use WAL. The source database is
 * never unlinked automatically: a concurrently running old binary may append new
 * work immediately after commit, and a later startup must be able to import it.
 */
export function migrateLegacyMessageStore(
	legacyDbPath: string,
	targetDbPath: string,
): LegacyMessageStoreMigrationResult {
	const sourcePath = resolve(legacyDbPath);
	const targetPath = resolve(targetDbPath);
	if (!existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink()) return EMPTY_RESULT;
	if (sourcePath === targetPath) return EMPTY_RESULT;
	if (existsSync(targetPath) && realpathSync(sourcePath) === realpathSync(targetPath)) return EMPTY_RESULT;

	// Upgrade both schemas before attaching them. This keeps the merge query
	// independent of which historical mailbox schema happens to be on disk.
	const sourceStore = new MessageStore(sourcePath);
	sourceStore.close();
	const targetStore = new MessageStore(targetPath);
	targetStore.close();

	const db = new DatabaseSync(targetPath);
	let attached = false;
	let sourceMessages = 0;
	let insertedMessages = 0;
	let sourceOutbox = 0;
	let insertedOutbox = 0;
	try {
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS legacy_message_imports (
				source_store_id TEXT NOT NULL,
				message_id      TEXT NOT NULL,
				imported_at     TEXT NOT NULL,
				PRIMARY KEY (source_store_id, message_id)
			)
			;
			CREATE TABLE IF NOT EXISTS legacy_outbox_imports (
				source_store_id TEXT NOT NULL,
				message_id      TEXT NOT NULL,
				imported_at     TEXT NOT NULL,
				PRIMARY KEY (source_store_id, message_id)
			)
		`);
		db.prepare("ATTACH DATABASE ? AS legacy").run(sourcePath);
		attached = true;
		const targetIdentity = db.prepare(`SELECT store_id FROM main.store_identity WHERE singleton = 1`).get() as {
			store_id: string;
		};
		const targetStoreId = targetIdentity.store_id;
		const sourceIdentity = db.prepare(`SELECT store_id FROM legacy.store_identity WHERE singleton = 1`).get() as {
			store_id: string;
		};
		const sourceStoreId = sourceIdentity.store_id;
		db.exec("BEGIN IMMEDIATE");
		try {
			sourceMessages = countRows(db, "messages", "status IN ('unread', 'pending')");
			const candidateMessages = (
				db
					.prepare(
						`SELECT COUNT(*) AS count
						   FROM legacy.messages old
						  WHERE old.status IN ('unread', 'pending')
						    AND NOT EXISTS (
						      SELECT 1 FROM main.legacy_message_imports imported
						       WHERE imported.source_store_id = ? AND imported.message_id = old.id
						    )`,
					)
					.get(sourceStoreId) as { count: number }
			).count;
			const inserted = db
				.prepare(
					`INSERT OR IGNORE INTO main.messages
					 (id, sender, recipient, content, created_at, status, drained_at, read_at,
					  claim_owner, claim_pid, priority, metadata_json)
					 SELECT id, sender, recipient, content, created_at, 'unread', NULL, NULL,
					        NULL, NULL, priority, metadata_json
					   FROM legacy.messages old
					  WHERE old.status IN ('unread', 'pending')
					    AND NOT EXISTS (
					      SELECT 1 FROM main.legacy_message_imports imported
					       WHERE imported.source_store_id = ? AND imported.message_id = old.id
					    )`,
				)
				.run(sourceStoreId) as { changes: number | bigint };
			insertedMessages = Number(inserted.changes);

			// Presence is local routing ownership, including offline Sessions that do
			// not currently have queued inbox rows. Never copy stale process/wake
			// capabilities; an already-current target row remains authoritative.
			db.prepare(
				`INSERT OR IGNORE INTO main.presence (agent_id, state, last_seen, pid, boot_id, wake_path)
					 SELECT agent_id, 'offline', last_seen, NULL, NULL, NULL
					   FROM legacy.presence`,
			).run();
			// A delivery-relevant inbox row is itself durable evidence that its
			// recipient belongs to this mailbox. Preserve that ownership even if an
			// interrupted legacy startup never wrote the matching presence row.
			db.prepare(
				`INSERT OR IGNORE INTO main.presence (agent_id, state, last_seen, pid, boot_id, wake_path)
					 SELECT recipient, 'offline', MAX(created_at), NULL, NULL, NULL
					   FROM legacy.messages
					  WHERE status IN ('unread', 'pending')
					  GROUP BY recipient`,
			).run();

			// Preserve endpoint configuration and the user's durable on/off choice,
			// while fencing every process-generation field from the old namespace.
			db.prepare(
				`INSERT OR IGNORE INTO main.peer_endpoints
				 (endpoint_id, remote, port, desired_state, observed_state, remote_store_id,
				  relay_pid, relay_boot_id, relay_generation, last_error, updated_at)
				 SELECT endpoint_id, remote, port, desired_state, 'closed', remote_store_id,
				        NULL, NULL, NULL, last_error, updated_at
				   FROM legacy.peer_endpoints`,
			).run();

			db.prepare(
				`INSERT OR IGNORE INTO main.peer_seen (message_id, first_seen_at, ingress_peer_store_id)
				 SELECT old.id, old.created_at, NULL
				   FROM legacy.messages old
				  WHERE old.status IN ('unread', 'pending')
				    AND NOT EXISTS (
				      SELECT 1 FROM main.legacy_message_imports imported
				       WHERE imported.source_store_id = ? AND imported.message_id = old.id
				    )`,
			).run(sourceStoreId);

			const verified = db
				.prepare(
					`SELECT COUNT(*) AS count
					   FROM legacy.messages old
					   JOIN main.messages current ON current.id = old.id
					  WHERE old.status IN ('unread', 'pending')
					    AND current.sender = old.sender
					    AND current.recipient = old.recipient
					    AND current.content = old.content
						    AND current.created_at = old.created_at
						    AND current.priority = old.priority
						    AND current.metadata_json IS old.metadata_json
						    AND NOT EXISTS (
						      SELECT 1 FROM main.legacy_message_imports imported
						       WHERE imported.source_store_id = ? AND imported.message_id = old.id
						    )`,
				)
				.get(sourceStoreId) as { count: number };
			if (verified.count !== candidateMessages) {
				throw new Error("legacy mailbox migration found a conflicting message id");
			}

			const importedAt = new Date().toISOString();
			const marked = db
				.prepare(
					`INSERT INTO main.legacy_message_imports (source_store_id, message_id, imported_at)
					 SELECT ?, old.id, ? FROM legacy.messages old
					  WHERE old.status IN ('unread', 'pending')
					    AND NOT EXISTS (
					      SELECT 1 FROM main.legacy_message_imports imported
					       WHERE imported.source_store_id = ? AND imported.message_id = old.id
					    )`,
				)
				.run(sourceStoreId, importedAt, sourceStoreId) as { changes: number | bigint };
			if (Number(marked.changes) !== candidateMessages) {
				throw new Error("legacy mailbox migration could not mark every imported message");
			}

			// Outbox payloads are delivery state, not diagnostic history. Copy every
			// message that has not transferred durable custody, including its per-link
			// gossip ledger. Claims are reset because the source process owns them. A
			// relayed envelope's previous hop is rebased to the target store identity;
			// otherwise every peer would reject it after the path migration.
			sourceOutbox = countRows(db, "peer_outbox", "settled_at IS NULL");
			type LegacyOutboxRow = {
				message_id: string;
				sender: string;
				recipient: string;
				content: string;
				created_at: string;
				priority: string;
				metadata_json: string | null;
				target_peer_store_id: string | null;
				received_at: string;
			};
			const outboxCandidates = db
				.prepare(
					`SELECT old.message_id, old.sender, old.recipient, old.content, old.created_at,
						        old.priority, old.metadata_json, old.target_peer_store_id, old.received_at
						   FROM legacy.peer_outbox old
						  WHERE old.settled_at IS NULL
						    AND NOT EXISTS (
						      SELECT 1 FROM main.legacy_outbox_imports imported
						       WHERE imported.source_store_id = ? AND imported.message_id = old.message_id
						    )
						  ORDER BY old.created_at DESC, old.rowid DESC`,
				)
				.all(sourceStoreId) as LegacyOutboxRow[];
			const candidateOutbox = outboxCandidates.length;
			const rebasedMetadata = new Map<string, ReturnType<typeof rebaseOutboxMetadata>>();
			const ensureLocalSender = db.prepare(
				`INSERT OR IGNORE INTO main.presence
					 (agent_id, state, last_seen, pid, boot_id, wake_path)
					 VALUES (?, 'offline', ?, NULL, NULL, NULL)`,
			);
			const hasTargetInbox = db.prepare(`SELECT 1 AS found FROM main.messages WHERE id = ?`);
			const insertOutbox = db.prepare(
				`INSERT OR IGNORE INTO main.peer_outbox
					 (message_id, sender, recipient, content, created_at, priority, metadata_json,
					  target_peer_store_id, status, claim_owner, claimed_at, forwarded_at,
					  next_attempt_at, attempt_count, received_at, settled_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0, ?, NULL)`,
			);
			for (const row of outboxCandidates) {
				const rebased = rebaseOutboxMetadata(row.metadata_json, sourceStoreId, targetStoreId);
				rebasedMetadata.set(row.message_id, rebased);
				// A locally-originated outbox row proves sender ownership even if the
				// legacy presence write was interrupted. Without this advertisement a
				// first-hop peer permanently rejects the imported message as spoofed.
				if (!rebased.federation || rebased.federation.originStoreId === targetStoreId) {
					ensureLocalSender.run(row.sender, row.created_at);
				}
				if (hasTargetInbox.get(row.message_id)) continue;
				const insertedOutboxResult = insertOutbox.run(
					row.message_id,
					row.sender,
					row.recipient,
					row.content,
					row.created_at,
					row.priority,
					rebased.metadata,
					row.target_peer_store_id,
					row.received_at === "" ? row.created_at : row.received_at,
				) as { changes: number | bigint };
				insertedOutbox += Number(insertedOutboxResult.changes);
			}

			db.prepare(
				`INSERT OR IGNORE INTO main.peer_outbox_delivery
				 (message_id, peer_store_id, status, claim_owner, claimed_at)
				 SELECT delivery.message_id, delivery.peer_store_id,
				        CASE
				          WHEN delivery.status IN ('forwarded', 'rejected') THEN delivery.status
				          ELSE 'pending'
				        END,
				        NULL, NULL
				   FROM legacy.peer_outbox_delivery delivery
				   JOIN legacy.peer_outbox old ON old.message_id = delivery.message_id
				  WHERE old.settled_at IS NULL
				    AND EXISTS (SELECT 1 FROM main.peer_outbox current WHERE current.message_id = old.message_id)`,
			).run();

			db.prepare(
				`INSERT OR IGNORE INTO main.peer_seen (message_id, first_seen_at, ingress_peer_store_id)
				 SELECT old.message_id, COALESCE(seen.first_seen_at, old.created_at), seen.ingress_peer_store_id
				   FROM legacy.peer_outbox old
				   LEFT JOIN legacy.peer_seen seen ON seen.message_id = old.message_id
				  WHERE old.settled_at IS NULL`,
			).run();

			const verifyOutbox = db.prepare(
				`SELECT 1 AS found FROM main.peer_outbox
					 WHERE message_id = ? AND sender = ? AND recipient = ? AND content = ?
					   AND created_at = ? AND priority = ? AND metadata_json IS ?`,
			);
			const verifyInbox = db.prepare(
				`SELECT 1 AS found FROM main.messages
					 WHERE id = ? AND sender = ? AND recipient = ? AND content = ?
					   AND created_at = ? AND priority = ? AND metadata_json IS ?`,
			);
			let verifiedOutbox = 0;
			for (const row of outboxCandidates) {
				const metadata = rebasedMetadata.get(row.message_id)?.metadata;
				const params = [
					row.message_id,
					row.sender,
					row.recipient,
					row.content,
					row.created_at,
					row.priority,
					metadata ?? null,
				];
				if (verifyOutbox.get(...params) || verifyInbox.get(...params)) verifiedOutbox += 1;
			}
			if (verifiedOutbox !== candidateOutbox) {
				throw new Error("legacy mailbox migration found a conflicting outbox message id");
			}

			const markedOutbox = db
				.prepare(
					`INSERT INTO main.legacy_outbox_imports (source_store_id, message_id, imported_at)
					 SELECT ?, old.message_id, ? FROM legacy.peer_outbox old
					  WHERE old.settled_at IS NULL
					    AND NOT EXISTS (
					      SELECT 1 FROM main.legacy_outbox_imports imported
					       WHERE imported.source_store_id = ? AND imported.message_id = old.message_id
					    )`,
				)
				.run(sourceStoreId, importedAt, sourceStoreId) as { changes: number | bigint };
			if (Number(markedOutbox.changes) !== candidateOutbox) {
				throw new Error("legacy mailbox migration could not mark every imported outbox message");
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}

		// This statement writes only the legacy database and runs after the target
		// commit. A crash before it leaves source rows unread, but their committed
		// import markers prevent reinsertion and let a later startup retry settlement.
		db.prepare(
			`UPDATE legacy.messages AS old
			    SET status = 'read', drained_at = NULL, read_at = ?,
			        claim_owner = NULL, claim_pid = NULL
			  WHERE old.status IN ('unread', 'pending')
			    AND EXISTS (
			      SELECT 1 FROM main.legacy_message_imports imported
			       WHERE imported.source_store_id = ? AND imported.message_id = old.id
			    )`,
		).run(new Date().toISOString(), sourceStoreId);

		// Imported source outbox rows are now redundant. Mark them settled first so
		// the mixed-version deletion trigger permits removal; a crash at any point is
		// idempotently completed from the target-side import marker on next startup.
		const settledAt = new Date().toISOString();
		db.prepare(
			`UPDATE legacy.peer_outbox AS old SET settled_at = ?
			  WHERE EXISTS (
			    SELECT 1 FROM main.legacy_outbox_imports imported
			     WHERE imported.source_store_id = ? AND imported.message_id = old.message_id
			  )`,
		).run(settledAt, sourceStoreId);
		db.prepare(
			`DELETE FROM legacy.peer_outbox_delivery
			  WHERE EXISTS (
			    SELECT 1 FROM main.legacy_outbox_imports imported
			     WHERE imported.source_store_id = ?
			       AND imported.message_id = legacy.peer_outbox_delivery.message_id
			  )`,
		).run(sourceStoreId);
		db.prepare(
			`DELETE FROM legacy.peer_outbox AS old
			  WHERE EXISTS (
			    SELECT 1 FROM main.legacy_outbox_imports imported
			     WHERE imported.source_store_id = ? AND imported.message_id = old.message_id
			  )`,
		).run(sourceStoreId);
	} finally {
		if (attached) {
			try {
				db.exec("DETACH DATABASE legacy");
			} catch {
				// Closing the connection below releases an attachment that cannot be
				// detached explicitly. The source is retained in either case.
			}
		}
		db.close();
	}

	return { sourceMessages, insertedMessages, sourceOutbox, insertedOutbox, removedSource: false };
}
