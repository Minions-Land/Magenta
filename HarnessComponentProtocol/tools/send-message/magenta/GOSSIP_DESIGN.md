# Gossip Flooding Design (Route 1)

## Architecture

Pure gossip flooding with per-link delivery tracking. Messages flood to relay links that explicitly advertise both transit support and durable custody, with receiver-side deduplication via `peer_seen` and `visitedStoreIds`. Deployed pre-gossip V1 links remain usable for direct first-hop traffic; the transit-only v0.0.29 link is receive-only until upgraded because its age-based outbox retention cannot safely accept custody.

Each configured SSH endpoint has an OS-level renewable lock beside `messages.db`. The supervisor uses that lock, not the persisted pid, as relay liveness; pid and boot id remain fenced observability metadata. While a lock is active, no supervisor may rewrite its persisted executable generation. The relay fingerprints the same binary or CLI invocation once per second and releases the lock when that on-disk artifact changes, after which one supervisor publishes the new generation and starts its replacement. This prevents both PID-reuse stalls and mixed-release supervisors repeatedly superseding one another.

## Schema Changes

### New Table: `peer_outbox_delivery`

Tracks delivery status per (message, peer_store) pair:

```sql
CREATE TABLE IF NOT EXISTS peer_outbox_delivery (
    message_id      TEXT NOT NULL,
    peer_store_id   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | inflight | forwarded | rejected
    claim_owner     TEXT,
    claimed_at      TEXT,
    PRIMARY KEY (message_id, peer_store_id)
);
CREATE INDEX IF NOT EXISTS idx_peer_outbox_delivery_claim
    ON peer_outbox_delivery(peer_store_id, status);
```

### Modified: `peer_outbox`

- `target_peer_store_id` and the legacy global status/claim columns remain for rollback/read compatibility
- Add `received_at` for legacy compatibility and receipt-age observability
- Add `settled_at`; current garbage collection uses only explicit custody settlement time
- New binaries use `peer_outbox_delivery`; legacy global claim columns are not authoritative under gossip

### Indexed: `peer_seen`

- `idx_peer_seen_retention(first_seen_at)` supports bounded deduplication-state maintenance
- No columns are removed or retyped, preserving old-binary rollback compatibility

## Core Logic

### sendRouted()
- No longer queries `peer_routes`
- Always inserts with `target_peer_store_id = NULL`
- Returns `disposition: "peer"` for non-local recipients (never "unresolved")

### acceptFederatedMessage()
Pure gossip rules:
1. Matching durable inbox/outbox payload → duplicate; seen-only marker → atomically reaccept; conflicting id → reject
2. Self in `visitedStoreIds` → reject (loop)
3. `hopsRemaining <= 0` → reject (TTL)
4. Local recipient → deliver to inbox
5. Else → insert outbox + pre-mark ingress as delivered

**Ingress pre-mark**: When relay receives message from peer X, immediately create delivery row `(message_id, X, 'forwarded')` to prevent echo.

### claimPeerOutbox()
- Ignores legacy route targets (all gossip messages are candidates)
- Joins with `peer_outbox_delivery` to exclude already-forwarded/inflight for this peer
- Creates delivery rows lazily only for rows actually selected for this connection
- Transit is eligible only when the caller explicitly enables it after capability negotiation
- On a durable transit connection, returns all messages without a delivery record for that peer
- On a legacy/direct-only connection, selects only locally-originated first-hop rows
- On a transit-only v0.0.29 connection, the Session does not call claim at all, so direct and transit rows receive no delivery record and remain immediately available after upgrade
- A durable connection reclaims v0.0.29 `forwarded` rows whose parent payload is still unsettled; the receiver's ingress pre-mark is excluded so recovery never echoes a relay payload backward

### Ack Handling
- `accepted` and `duplicate` mark the per-link delivery row forwarded
- They set the parent `settled_at` only when the remote advertises `durable-custody-v1`, or when a pre-gossip direct-only peer accepts into the durable inbox guaranteed by that protocol
- `not_found` records the distinct terminal delivery state `rejected`; this prevents durable recovery of ambiguous v0.0.29 rows from becoming a hot retry loop
- A receiver returns `duplicate` only while an inbox/outbox row with the same stable business payload still exists. Federation hop metadata is ignored; a seen-only tombstone is atomically removed and reaccepted, and a conflicting payload with the same id is rejected

## Mixed-Version Capability Negotiation

Protocol V1 hello and hello_ack frames may include `capabilities: ["gossip-transit-v1", "durable-custody-v1"]`. The field is optional: pre-gossip V1 parsers ignore it when received and omit it in their response. Protocol number, envelope schema, ack schema, and the 64 KiB frame limit remain unchanged.

Outbound behavior is based only on the remote advertisement:

- both capabilities: the link carries direct and transit envelopes, and accepted/duplicate ACKs settle durable custody
- `gossip-transit-v1` only (v0.0.29): the new side sends no outbound envelopes, but continues accepting valid inbound traffic
- neither capability (pre-gossip V1): the link carries direct, locally-originated envelopes only; accepted/duplicate proves durable local inbox custody
- skipped rows are not claimed and gain no per-link status, so a fresh handshake after peer upgrade can claim them immediately

This is deliberately directional. A new peer can still validate incoming traffic from an old peer according to the existing V1 trust rules; omission only limits what the new peer sends toward that connection.

## Garbage Collection

Delivered inbox and outbox retention both default to 7 days. Inbox retention starts at `read_at`, when context injection is confirmed, so a message queued offline for longer than the retention window still receives a full post-delivery window. Active links and ordinary mailbox operations attempt hourly maintenance, while a database-level lease ensures only one process performs it per store. Each pass deletes at most eight 500-row batches per table, in order: terminal `read` inbox rows, expired outbox and delivery-ledger rows, then expired `peer_seen` rows. Unread and pending inbox delivery remains durable regardless of age. Startup migration also heals empty `received_at` values written by interim binaries.

Dedup retention defaults to `peerOutboxRetentionMs * DEFAULT_PEER_LINK_HOPS`, currently 14 days. This covers the maximum V1 delayed-flood window: one full durable outbox delay at each permitted hop. Configuration below that minimum is rejected. An expired seen marker remains protected while the same message still has an active outbox body; after the body expires, one maintenance pass removes the body, its delivery rows, and the marker. During rolling upgrade, a v0.0.29 marker can outlive its age-purged outbox body; receipt of that id removes the orphan marker and atomically restores the payload instead of issuing a false custody ACK.

## TTL/Hops

- Protocol V1 keeps `DEFAULT_PEER_LINK_HOPS = 2` for wire compatibility with deployed V1 binaries
- Two hops cover source -> relay -> destination; larger topologies require a negotiated protocol revision
- Parser bounds remain `visitedStoreIds.length <= 2` and `hopsRemaining <= 2`

## Anti-Spoofing

The SSH endpoint is the authenticated trust boundary:
- First-hop envelopes must advertise a sender owned by the ingress store
- Multi-hop envelopes validate the immediate previous hop and loop/TTL bounds
- V1 does not sign the full visited chain, so configured relay hubs are trusted mailbox routers; untrusted peers require a future per-hop signature protocol

## Deprecated Methods

- `registerPeerRoute()` — deleted (gossip doesn't use single-route registration)
- `listAdvertisableSessions()` / `replacePeerRoutes()` — retained for observability and first-hop ownership checks, but not forwarding decisions
- Session advertisements prioritize local sessions and are deterministically truncated to the 64 KiB V1 frame budget instead of terminating the link
- `includeUnresolvedOutbound` parameter — retained but ignored for compatibility (all messages flood)

## Test Coverage

1. Multi-leaf parallel flood (A, C both receive from B simultaneously)
2. Offline recipient (haofeng offline, messages queue, reconnect delivers)
3. Deduplication via `peer_seen`
4. Loop prevention via `visitedStoreIds`
5. TTL convergence and V1 two-hop compatibility
6. Batch size edge cases (batch_size=1)
7. Ingress pre-mark prevents echo
8. Large session advertisements stay within the frame bound
9. Attached links schedule outbox and dedup retention maintenance
10. Pre-gossip V1 hello_ack/responder semantics: direct delivery settles safely while transit remains unclaimed
11. Transit-only v0.0.29 peers receive no outbound claims; a durable reconnect immediately recovers and settles retained payloads
12. Old forwarded ledgers exclude ingress echoes, terminal rejections do not hot-loop, and seen-only markers atomically reaccept
13. `peer_seen` stays inside the TTL delay safety window, expires afterward, and preserves active associated state
