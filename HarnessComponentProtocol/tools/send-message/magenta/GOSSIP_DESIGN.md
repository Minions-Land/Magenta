# Gossip Flooding Design (Route 1)

## Architecture

Pure gossip flooding with per-link delivery tracking. Messages flood to all connected relay links, with receiver-side deduplication via `peer_seen` and `visitedStoreIds`.

## Schema Changes

### New Table: `peer_outbox_delivery`

Tracks delivery status per (message, peer_store) pair:

```sql
CREATE TABLE IF NOT EXISTS peer_outbox_delivery (
    message_id      TEXT NOT NULL,
    peer_store_id   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | inflight | forwarded
    claim_owner     TEXT,
    claimed_at      TEXT,
    PRIMARY KEY (message_id, peer_store_id)
);
CREATE INDEX IF NOT EXISTS idx_peer_outbox_delivery_claim
    ON peer_outbox_delivery(peer_store_id, status, claimed_at);
```

### Modified: `peer_outbox`

- `target_peer_store_id` and the legacy global status/claim columns remain for rollback/read compatibility
- Add `received_at` for time-based garbage collection
- New binaries use `peer_outbox_delivery`; legacy global claim columns are not authoritative under gossip

## Core Logic

### sendRouted()
- No longer queries `peer_routes`
- Always inserts with `target_peer_store_id = NULL`
- Returns `disposition: "peer"` for non-local recipients (never "unresolved")

### acceptFederatedMessage()
Pure gossip rules:
1. `peer_seen` duplicate → reject
2. Self in `visitedStoreIds` → reject (loop)
3. `hopsRemaining <= 0` → reject (TTL)
4. Local recipient → deliver to inbox
5. Else → insert outbox + pre-mark ingress as delivered

**Ingress pre-mark**: When relay receives message from peer X, immediately create delivery row `(message_id, X, 'forwarded')` to prevent echo.

### claimPeerOutbox()
- Ignores `peerStoreId` in WHERE (claims all pending messages)
- Joins with `peer_outbox_delivery` to exclude already-forwarded/inflight for this peer
- Creates delivery rows lazily: `INSERT OR IGNORE INTO peer_outbox_delivery`
- Returns all messages without a delivery record for the claiming peer

### Ack Handling
- All ack statuses (accepted/duplicate/not_found) mark delivery as forwarded
- TTL exhaustion and loops return `not_found` but stop retry on that link

## Garbage Collection

Time-based retention defaults to 7 days. Every attached `PeerLinkSession` schedules hourly storage maintenance; `MessageStorePeerLinkAdapter.runMaintenance()` removes expired outbox and delivery-ledger rows. Startup migration also heals empty `received_at` values written by interim binaries.

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
- `includeUnresolvedOutbound` parameter — removed (all messages flood)

## Test Coverage

1. Multi-leaf parallel flood (A, C both receive from B simultaneously)
2. Offline recipient (haofeng offline, messages queue, reconnect delivers)
3. Deduplication via `peer_seen`
4. Loop prevention via `visitedStoreIds`
5. TTL convergence and V1 two-hop compatibility
6. Batch size edge cases (batch_size=1)
7. Ingress pre-mark prevents echo
8. Large session advertisements stay within the frame bound
9. Attached links schedule retention maintenance
