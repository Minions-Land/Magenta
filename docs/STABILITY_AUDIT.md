# Magenta Stability Audit

Date: 2026-07-22
Status: Unreleased engineering fixes; not a public release attestation

The active Magenta product version remains unchanged and matches the latest
released changelog heading. Every correction described here belongs to the
single `Unreleased` section and is not a new release claim.

## Scope

This audit covers local credential discovery and provider routing, prompt-cache
stability, long-running sub-agents and workflows, multiagent RPC, durable peer
mailboxes and SSH relays, diagnostic write amplification, eval validity, local
binary construction, self-update transactions, and the public release path.

The audit treats mailbox databases, unread messages, unsettled relay payloads,
Session transcripts, credentials, harness packages, and multiagent registries
as production state. They are not caches and must not be removed by routine
cleanup.

## Engineering Findings And Corrections

### Local API discovery

The previous Codex loader parsed TOML with line matching, guessed a fallback
endpoint from inactive provider tables, and did not reliably carry a discovered
endpoint into the provider request. It could also mistake a ChatGPT OAuth access
token for an OpenAI API key. Claude Code bearer credentials were represented as
ordinary API keys, which selected the wrong Anthropic header.

The loader now uses a TOML parser, selects only the explicit active provider,
and returns no custom endpoint when no provider is active. Provider-scoped
credential metadata carries the selected base URL into Anthropic, Google, and
OpenAI request authentication. Anthropic auth tokens use Bearer authentication,
and Codex OAuth tokens are not downgraded into API keys.

Codex and Claude Code configuration is an external read-only source. Magenta's
production loader imports only `existsSync` and `readFileSync` for those files;
login and logout write or delete credentials only in Magenta's own auth store
under the Magenta agent directory. Regression tests assert that a Codex
configuration's inode, contents, mode, and timestamps do not change during
discovery, and that logout leaves an external Claude Code credential file intact.

### Cache behavior

The default system prompt included the wall-clock date, which changed a stable
provider prefix at midnight. Tool changes made during a run could miss the next
provider request, and cache telemetry could classify provider payloads it did
not understand as ordinary misses. A shared telemetry filename also allowed
multiple processes and repeated Sessions in one process to interfere with
rotation and retention.

The default prompt no longer embeds a changing date. The next-turn preparation
path refreshes tool and prompt state after tool activation. Unsupported provider
payload layouts fail closed as `unclassified_payload`. Opt-in telemetry uses
process- and Session-owned active files, retires each file on Session disposal,
and applies finite per-file, age, count, and total-size retention without
persisting plaintext prompts or provider output.

Google, Vertex, Bedrock, and Mistral payloads are not yet structurally classified
for cache-cause attribution. Their telemetry is deliberately inconclusive rather
than a false diagnosis.

### Timeouts, memory, and diagnostic writes

Sub-agents and workflows previously inherited an implicit one-hour wall limit.
Some long-running paths retained unbounded NDJSON frames, assistant history, or
stderr. Several diagnostics wrote small chunks immediately, and internal RPC
traces copied cumulative token-level message updates, creating work that grew
quadratically with a long response.

Omitting a sub-agent or workflow timeout now means no hard deadline. Explicit
timeouts share the validated Node timer range. A persistent teammate Session has
no total lifetime limit; its individual RPC command default is five minutes.
Worker frames, history, stderr, bash full output, background-shell logs, eval
artifacts, and cache telemetry have explicit byte and retention bounds.
Diagnostic streams batch up to the shared byte threshold or 100 ms and flush on
every terminal path. Internal teammate RPC suppresses cumulative token updates
while ordinary RPC clients retain the complete event stream.

These changes avoid the failure mode seen in an external Codex installation,
where a shared log database grew to gigabyte scale while several live processes
held the database and WAL. Magenta does not use an unbounded shared SQLite trace
table for token-level diagnostics.

### Durable mailbox and SSH gossip

The previous design had several independent data-loss and liveness risks:

- legacy agent-local and machine-global stores could disagree during migration;
- retention could age out unread inbox rows or unacknowledged outbox payloads;
- idle polling acquired SQLite write locks even when no work was claimable;
- a reusable PID and supervisor-written generation metadata acted as ownership;
- a replaced binary did not reliably fence an old responder or restart a relay;
- non-interactive SSH could miss the remote install path, while startup stderr
  was not retained as a useful bounded diagnostic.

Migration now imports unread inbox state, unsettled outbox state, delivery
ledgers, endpoint state, and offline ownership before settling the verified
source rows. Transit metadata is normalized to the target store's final hop and
malformed ownership metadata rolls back as one transaction. Missing sender
ownership is recovered as offline presence.

Unread and pending inbox rows, plus unsettled outbox payloads, have no age-based
deletion path. Maintenance deletes only terminal rows in bounded batches and is
coordinated by an hourly lease. An empty claim probe stays read-only, so an idle
link does not churn the mailbox WAL.

Each endpoint now has an OS-level lock. Only its lock owner may publish an
executable generation; PID and database metadata are diagnostic, not ownership
proof. Lock inspection errors fail closed. Relay handoff releases the old lock,
then retries a successor with bounded backoff until a new owner appears or the
endpoint is closed. The remote command supports an explicit binary and otherwise
checks `PATH` before the standard user install path. SSH stderr retains only a
bounded tail. New responders monitor their executable generation and close the
wire after replacement so the initiator reconnects to the installed version.

Compiled Bun executables expose a virtual `/$bunfs/root/magenta` argument that is
not present in an ordinary Node invocation. Passing it through during relay
handoff caused the successor to enter the normal CLI instead of `_peer relay`.
Successor argument normalization now removes only that executable entry, with
compiled-runtime coverage for the exact handoff shape.

The endpoint lock intentionally updates filesystem lease metadata every ten
seconds so a crashed owner becomes stale after thirty seconds. This is a small,
bounded filesystem heartbeat, not an SQLite/WAL polling write.

### Eval validity

The previous runner could report success when a requested component was unknown,
an off-state had no executable isolation, a child failed with a structurally
valid transcript, or the configured scorer never ran. Fixed-order single runs
also shared their environment and provider cache while resembling A/B evidence.

Real runs now fail before model calls or artifact creation when component state
cannot map to an executable control. Contract validity, child execution success,
scorer status, and comparison-evidence eligibility are separate fields. Output
is streamed into private bounded artifacts; truncation invalidates the arm.
Current fixed-order, shared-environment, single-repetition comparisons explicitly
set `comparisonClaimAllowed = false`.

The remaining experimental debt is substantive: most registered assumptions do
not yet have real scenarios; evaluator provenance lacks a complete
commit/diff/checksum/environment/seed/repetition chain; and a benchmark driver
still needs isolated environments, counterbalanced order, and repetitions.

### Build, update, and release

Ignored build output allowed a clean Git tree to package stale code. Version
sources and compiled resources were not checked as one invariant. Binary/resource
replacement, unsupported architectures, and local archives had incomplete
transaction or completeness checks.

Release preparation now starts with a clean offline build, verifies active brand
and compiled resource versions, runs non-mutating release checks and the full
test suite, and rejects dirty or diverged release state. Binary, resource, and
helper-tree activation is staged and rolled back atomically. The built-in updater
and standalone Windows installer share a per-installation lock and private,
durable crash journal; each recovers interrupted staging, backup, or activation
before beginning another mutation, and executable replacement remains atomic on
Unix and Windows. Unsupported architectures fail instead of receiving a nearby
asset. Local archives are rebuilt and verified file-for-file. Completed local
macOS binaries receive and pass strict ad-hoc signature validation, which is
suitable only for local testing.

Unix archive extraction now uses `--no-same-owner`. Without it, a privileged
installer restored the build runner's numeric UID, after which the transaction's
ownership checks correctly refused to move the staged resources. Release notes
are selected from the exact version section in `CHANGELOG.md`; a missing, empty,
or still-unreleased section blocks publication instead of producing misleading
notes.

Public macOS release remains blocked without organization-owned Developer ID
signing and notarization. The source repository workflows for the current
published tag did not start because repository Actions execution was unavailable.
A public asset set and downstream verifier exist and its `SOURCE_COMMIT` matches
the source tag, but that downstream verification cannot replace missing
source-build provenance. Do not assign a new release version to the current
`Unreleased` work until Actions availability, signing, native platform jobs,
review, and the normal version/tag flow are complete.

The canonical Unix bootstrap currently lives only on the public distribution
repository's mutable main branch. It is not a source-workflow asset covered by
`SHA256SUMS` or `SOURCE_COMMIT`, and its activation path explicitly performs an
in-place resource copy with only binary exception rollback. A crash can leave a
binary gap or mixed resources. The public distribution repository must adopt a
source-bound, checksummed installer with the same lock, journal, atomic binary
replacement, and recovery invariants before Unix fresh installation is treated
as a complete release transaction.

Rollback directories are temporary transaction state. Successful activation
deletes them; immutable source tags, workflow attestations, checksums, and
published release metadata are the durable release record. Developer machines
do not need accumulating binary backup directories.

## Remaining Limitations

The detached peer relay survives an interactive Session exit, SSH child failure,
and executable replacement, but Magenta does not install an operating-system
service. A host reboot therefore requires the next Magenta startup to recreate
the relay. Adding launchd/systemd ownership is a separate product and lifecycle
decision, not an invariant claimed by this patch.

Cache-cause attribution remains deliberately unavailable for Google, Vertex,
Bedrock, and Mistral payloads. Public release is still blocked on Developer ID
signing/notarization, a source-owned transactional Unix bootstrap, and native
Windows crash-recovery evidence. These gates must not be bypassed to publish the
current `Unreleased` work.

## Cleanup Boundary

Safe routine cleanup is limited to recognized, reproducible artifacts such as
repository build targets, owned binary staging directories, stale test result
directories, repository-local workflow scratch space, downloaded tool caches,
and closed bounded diagnostic logs. A path must not be removed while a live
process has it open or uses it as its executable.

The following are durable and must be preserved:

- `messages.db`, its WAL/SHM files, endpoint locks, unread inbox rows, and
  unsettled outbox rows;
- agent Session transcripts, credentials, settings, and model metadata;
- harness packages and user-installed skills;
- multiagent registries and active logs;
- the active binary/resource installation until staged replacement is verified.

On the audited macOS host, `~/.Magenta` and `~/.magenta` resolve to the same
directory inode. They are casing aliases on the filesystem, not duplicate trees.

## Verification Record

Repository-wide verification passed `npm run check:release`, `npm test`, active
brand/generated-source/compiled-dist version checks, `actionlint`, Biome,
TypeScript, and `git diff --check`. The final full run contained 4,563 passing
and 785 skipped tests with no failures, including 64 focused updater tests and
714 Harness tests.

Rebuilt and installed binaries matched the repository's active version identity.
Their SHA-256 values were
`8d004707a6f2c7603d486e3abc0509c355979f5f93d9fa0b5dbf3adc082b8b26`
on macOS and
`ebf4874ab50a66cd09e31062f7b3b7a1ec3cf13632f8d089848ef6feca75f3c0`
on Linux. The macOS binary passed strict ad-hoc code-signature validation; it is
not a public Developer ID signature. Both shared installation directories were
updated through the crash-safe journal transaction with exact-hash and resource
verification, and no transaction staging, backup, journal, or lock remained.

The production two-host check preserved every pre-existing unread row and every
original outbox payload; independently recorded counts and business-field hashes
matched before and after the installation. Rows changed custody state only after
a durable acknowledgement. Bidirectional register/send/drain passed before and
after killing the SSH child, with a new SSH PID, a new remote responder, and the
endpoint returning to `connected`.

An idle 60-second local sample and a separate 105-second remote sample left the
mailbox DB, WAL, and SHM inode, size, mtime, and ctime unchanged. Only the local
endpoint lock heartbeat changed. Two unrelated external peer connections were
observed on the remote host and preserved; one earlier sample that overlapped a
real external handshake was discarded rather than reported as idle evidence.

The audited Codex configuration retained an unchanged content hash, inode, mode,
size, mtime, and ctime across credential discovery. Current Magenta production
code has no write path to that file. The historical process that recreated it
before this audit is not proven. The external Codex `logs_2.sqlite` remained live
and was deliberately neither deleted nor vacuumed.

Exact-path cleanup reclaimed multiple GiB of reproducible builds, closed
diagnostic logs, caches, old toolchains, test trees, and superseded binary
backups. Mailbox databases and sidecars, unread or unsettled rows, Sessions,
credentials, harness packages, installed skills, and multiagent registries were
preserved. The remote profile and mailbox permissions were tightened to 0700 and
0600 respectively.

The repository contains static Windows installer transaction checks and a native
workflow recovery fixture, but the source Actions jobs did not start, so native
Windows crash-recovery evidence remains missing. The public Unix installer stays
blocked by `unix-installer-gate` until the source-owned transaction passes native
fault injection.
