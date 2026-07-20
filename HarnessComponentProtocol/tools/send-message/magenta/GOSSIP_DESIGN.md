# Gossip Flooding Design (Route 1)

## Architecture

Pure gossip flooding with per-link delivery tracking. Messages flood to all transit-capable relay links, with receiver-side deduplication via `peer_seen` and `visitedStoreIds`. Deployed V1 links that do not advertise transit capability remain usable for direct first-hop traffic.

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
1. `peer_seen` duplicate → reject
2. Self in `visitedStoreIds` → reject (loop)
3. `hopsRemaining <= 0` → reject (TTL)
4. Local recipient → deliver to inbox
5. Else → insert outbox + pre-mark ingress as delivered

**Ingress pre-mark**: When relay receives message from peer X, immediately create delivery row `(message_id, X, 'forwarded')` to prevent echo.

### claimPeerOutbox()
- Ignores legacy route targets (all gossip messages are candidates)
- Joins with `peer_outbox_delivery` to exclude already-forwarded/inflight for this peer
- Creates delivery rows lazily only for rows actually selected for this connection
- On a transit-capable connection, returns all messages without a delivery record for that peer
- On a legacy/direct-only connection, selects only locally-originated first-hop rows; transit rows receive no delivery record and remain retryable after upgrade

### Ack Handling
- All ack statuses (accepted/duplicate/not_found) mark a message actually sent on that link as forwarded
- TTL exhaustion and loops return `not_found` and stop retry on that link
- A transit envelope is never sent to a peer that omitted transit capability, so a deployed V1 responder cannot convert its compatibility `not_found` into a false permanent delivery

## Mixed-Version Capability Negotiation

Protocol V1 hello and hello_ack frames may include `capabilities: ["gossip-transit-v1"]`. The field is optional: origin/main's V1 parser ignores it when received and its hello_ack omits it. Protocol number, envelope schema, ack schema, and the 64 KiB frame limit remain unchanged.

Outbound behavior is based only on the remote advertisement:

- capability present: the link may carry direct and transit envelopes
- capability absent: the link carries direct, locally-originated V1 envelopes only
- transit rows skipped on a legacy link are not claimed and gain no per-link status, so a fresh handshake after peer upgrade can claim them

This is deliberately directional. A new peer can still validate incoming traffic from an old peer according to the existing V1 trust rules; omission only limits what the new peer sends toward that connection.

## Garbage Collection

Outbox retention defaults to 7 days. Every attached `PeerLinkSession` schedules hourly storage maintenance; `MessageStorePeerLinkAdapter.runMaintenance()` first removes expired outbox and delivery-ledger rows, then removes expired `peer_seen` rows. Startup migration also heals empty `received_at` values written by interim binaries.

Dedup retention defaults to `peerOutboxRetentionMs * DEFAULT_PEER_LINK_HOPS`, currently 14 days. This covers the maximum V1 delayed-flood window: one full durable outbox delay at each permitted hop. Configuration below that minimum is rejected. An expired seen marker remains protected while the same message still has an active outbox body; after the body expires, one maintenance pass removes the body, its delivery rows, and the marker. Inbox rows need no retention exception because their message primary key still rejects a replay and atomically recreates the seen marker.

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
9. Attached links schedule outbox and dedup retention maintenance
10. Origin/main V1 hello_ack/responder semantics: direct delivery works, transit stays unsent and retryable until upgrade
11. `peer_seen` stays inside the TTL delay safety window, expires afterward, and preserves active associated state
