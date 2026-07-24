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
binary construction, self-update transactions, repository-history exposure, and
the public release path.

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

Magenta's own auth store now uses a private atomic replacement under a
symlink-refusing file lock. Login, logout, and OAuth refresh update the in-memory
credential map only after that durable write succeeds; a disk or permission
failure therefore remains visible to the caller instead of creating a false
logged-in state for the current process.

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

The local MCP descriptor cache now uses bounded secure reads, private atomic
writes, bounded directory tracking, cleanup after every successful write, and
an executable identity containing device, inode, ctime, mtime, size, and the
resolved PATH location. Commands whose executable identity cannot be resolved
are not cached. Package MCP assembly receives an explicit host cache root, so
source worktrees are not polluted by runtime cache files.
GitHub Harness Package caches use the same conservative ownership model: an
invalid direct cache is never removed or renamed because another process may be
executing it. A fully downloaded, checksum-verified, archive-inspected repair is
published as an immutable sibling generation and selected only after provenance,
owner, link-count, realpath, manifest, version, platform, and artifact-hash checks.
Dangling links and unknown generation entries are preserved and fail closed.

Google, Vertex, Bedrock, and Mistral payloads are not yet structurally classified
for cache-cause attribution. Their telemetry is deliberately inconclusive rather
than a false diagnosis.

### State storage and migration

Legacy `~/.pi/agent` migration previously copied directly into the destination,
so an interrupted copy could expose a partially migrated profile. Migration now
copies into a private sibling staging directory and atomically publishes only a
complete result; failure removes only that staging tree. Auth state, update-check
timestamps, and shared Harness cache metadata use bounded regular-file reads,
private atomic writes, and symlink refusal. Sessions, credentials, settings,
mailbox databases, installed packages, and unread or unsettled gossip state are
never classified as disposable cache data.

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
link does not churn the mailbox WAL. Re-advertising the same Session member set,
recording unchanged presence, or publishing an identical relay state/error is
also write-free; timestamps advance only with a durable state change.

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

The endpoint lock intentionally updates filesystem lease metadata every twenty
seconds and treats the lease as stale after sixty seconds. The 20-second
refresh remains at least 10 seconds inside the legacy 30-second checker used by
older Magenta versions, so a healthy new owner is not stolen during a mixed
version rollout. This halves the steady-state metadata writes to about 4,320
per day per continuously held endpoint lock. A crashed owner is eligible for
takeover no later than 60 seconds after its last successful refresh, plus normal
scheduler/filesystem latency. This is a small, bounded filesystem heartbeat,
not an SQLite/WAL polling write.

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

Transaction journal v6 records each original path and staged resource object's
exact filesystem identity before the first move or replacement, and binds the
staged binary by SHA-256. Activation and rollback recheck the applicable
identity or digest, including Windows volume/file IDs, so a path replaced by
another process is preserved for manual recovery instead of being deleted or
overwritten. Recovery remains compatible
with journals v1 through v5. Release and Package downloads stream into partial
files with declared and observed byte limits; resource and Package archives
also enforce compressed, uncompressed, logical-file, single-entry, record-count,
and extraction-time limits before activation.

Unix archive extraction now uses `--no-same-owner`. Without it, a privileged
installer restored the build runner's numeric UID, after which the transaction's
ownership checks correctly refused to move the staged resources. Release notes
are selected from the exact version section in `CHANGELOG.md`; a missing, empty,
or still-unreleased section blocks publication instead of producing misleading
notes.

The public distribution verifier no longer trusts a mutable latest-asset
handoff. The Unix bootstrap resolves one GitHub API tag and installer digest,
then pins that exact tag into the full installer; the documented Windows path
performs the same unique-asset, size, digest, and exact-tag checks. Windows and
macOS verification download by immutable GitHub asset ID with bounded streaming.
For releases using the current source-bound contract, a dedicated fine-grained read-only token peels the exact
annotated tag in the private source repository and compares it with
`SOURCE_COMMIT` before downloaded code runs. Native Apple Silicon and Intel jobs
then materialize process-tools, fd, and ripgrep in isolated secret-free homes
and bind all six helper bytes, identifiers, Team IDs, signatures, and receipt
hashes independently of the source workflow.

The local release rehearsal exposed one first-install defect before publication:
the compiled helper-proof command treated a missing `~/.magenta` directory as an
already-existing trusted root. It now creates the private cache tree from the
current user's real home through the same owner, mode, and symlink checks used by
normal helper materialization. Both compiled macOS architectures passed the proof
from completely fresh isolated homes after the fix.

`MagentaPackages` now validates the real repository and Cardiomni runtime in CI.
Package archives normalize gzip/tar timestamps, owners, and modes for reproducible
hashes and include only regular files in the Git index, so ignored or untracked
local clinical examples and editor configuration cannot enter an archive. Release
tags must belong to verified `main`; a new destination is staged
as a draft, its exact four-platform artifact/checksum set is compared with remote
GitHub sizes and digests, and only then is the draft published. Existing Releases
are never overwritten in place. Directory fsync failures propagate, and prior
artifact/checksum backups remain available until replacement names are durable.

Public macOS release remains blocked until organization-owned Developer ID and
notary credentials are configured in the protected release environment. The
latest source jobs did not execute a single build step: GitHub annotated them
with "The job was not started because recent account payments have failed or
your spending limit needs to be increased." The repository itself has Actions
enabled, so changing workflow code or repository visibility does not solve this
account-level runner block.
A public asset set and downstream verifier exist and its `SOURCE_COMMIT` matches
the source tag, but that downstream verification cannot replace missing
source-build provenance. Do not assign a new release version to the current
`Unreleased` work until Actions availability, signing, native platform jobs,
review, and the normal version/tag flow are complete.

The Unix bootstrap is now source-owned, checksummed, and versioned with the
Release. Its thin shell layer delegates to the same lock, durable journal,
atomic binary replacement, and full resource rollback engine as self-update;
native Linux and macOS workflow jobs exercise deterministic crash recovery.

Rollback directories are temporary transaction state. Successful activation
deletes them; immutable source tags, workflow attestations, checksums, and
published release metadata are the durable release record. Developer machines
do not need accumulating binary backup directories.

### Repository history and public-source publication

The private source repository must not be made public in place. A forensic scan
found one historical classic GitHub PAT in four paths. The current tree and all
branch and tag tip trees are clean, but all four remote branch histories and 24
release tags can still reach the leaked object. The token's SHA-256 fingerprint
is `78ccf3a5e16d7419e2da6a5df081d304298ce9dcc0d8465ea721f7419436d7ed`;
the secret itself is intentionally not reproduced. History rewriting cannot
revoke a credential, so its owner must explicitly revoke it in GitHub before
any public-source migration.

The safe publication path is a new repository with one reviewed root commit
created from an allowlisted current snapshot. Old branches, tags, Releases,
pull-request refs, Actions artifacts, and workflow logs must not be imported.
The existing source repository should remain private and may be archived after
the replacement is verified. This avoids pretending that an in-place force
push can retract objects already copied into release metadata, caches, or refs
outside ordinary branch history.

The repository now includes a fail-closed snapshot exporter for that path. It
reads only Git-tracked files from an explicit current-tree allowlist, requires a
clean owner-reviewed source commit plus digest-pinned root legal files, and runs
built-in secret/sensitive-term checks and a gitleaks directory scan. Approved
interoperability names require exact path, line, line-digest, and justification
entries; package roots and binary assets require separate explicit approvals.
Write mode creates a new local repository with one parentless `main` commit and
verifies that no source history, remote, tags, or additional refs exist. It
never creates a remote or pushes.

`MagentaPackages` needs a separate content and license review before the same
process. Its current product tree intentionally contains `Biomni`,
`PantheonOS`, and `BiomniBench` references (along with related package names),
and existing private Releases and Actions artifacts name those packages.
Removing words from Git commit messages would neither remove the shipped code
nor establish redistribution rights. `Codex` and `Claude Code` are also real
provider and credential-interoperability contracts in Magenta; mechanically
renaming them would break supported behavior. A public package snapshot
therefore needs an explicit package allowlist and attribution review, not a
global search-and-replace. The exporter additionally blocks `Panther OS`,
`BioMesh`, `BioMeshBatch`, `DA Code`, and `Q-Less` unless an owner-approved
snapshot policy excludes or handles the containing paths.

Neither public repository currently has an approved root `LICENSE` and
`NOTICE`. Copyright ownership and third-party redistribution terms must be
decided by the repository owners before treating public redistribution as
licensed; this audit does not guess a license on their behalf.

## Remaining Limitations

The detached peer relay survives an interactive Session exit, SSH child failure,
and executable replacement, but Magenta does not install an operating-system
service. A host reboot therefore requires the next Magenta startup to recreate
the relay. Adding launchd/systemd ownership is a separate product and lifecycle
decision, not an invariant claimed by this patch.

Cache-cause attribution remains deliberately unavailable for Google, Vertex,
Bedrock, and Mistral payloads. Public Actions are now executing successfully on
Linux, macOS arm64, macOS Intel, and Windows, and the source repository has the
required `macos-release` and `cli-release` environment names. Publication
remains externally blocked because neither environment has its protected
release credentials, both source and distribution trust files still contain
`UNCONFIGURED`, and the audited host has zero valid Developer ID identities.
The existing repository-level `MAGENTA_CLI_RELEASE_TOKEN` must be reviewed and
rotated into `cli-release` before it is trusted for cross-repository
publication. Mock contracts, local ad-hoc signatures, and dry-runs cannot
substitute for one successful signed and notarized release workflow.

The repositories are already public. Copyright ownership, the missing root
license and notice files, and any historical credential revocation remain owner
decisions; public visibility does not resolve them automatically.

## Cleanup Boundary

Safe routine cleanup is limited to recognized, reproducible artifacts such as
repository build targets, owned binary staging directories, stale test result
directories, repository-local workflow scratch space, downloaded tool caches,
and closed bounded diagnostic logs. A path must not be removed while a live
process has it open or uses it as its executable.

The low-frequency maintenance primitives now require a current-user-owned
regular object, a recognized schema/name, an age bound, and a final device/inode
check. Stale wake sockets additionally require a definitely dead PID and a
failed bounded connection probe. Empty teammate registries are candidates only
after a complete Session-id scan proves their parent absent; an incomplete or
malformed scan performs no registry deletion. Workflow, sub-agent, and MCP
cache cleanup preserves symlinks, hard links, temporary/lock siblings, live-PID
artifacts, and every object whose ownership or identity is uncertain.

The following are durable and must be preserved:

- `messages.db`, its WAL/SHM files, endpoint locks, unread inbox rows, and
  unsettled outbox rows;
- agent Session transcripts, credentials, settings, and model metadata;
- harness packages and user-installed skills;
- non-empty or live-parent multiagent registries and active logs;
- the active binary/resource installation until staged replacement is verified.

On the audited macOS host, `~/.Magenta` and `~/.magenta` resolve to the same
directory inode. They are casing aliases on the filesystem, not duplicate trees.

## Verification Record

The final local source state passed a clean offline build, brand/version checking,
`npm run check:release`, and `npm test`. The full Magenta3 test command reported
4,814 passed, 785 skipped, and zero failed: scripts 140/140; Harness 779/779;
memory 4/4; agent-core 75/75; AI 625 passed plus 738 skipped; coding-agent 2,455
passed plus 47 skipped; and TUI 736/736. The five earlier coding-agent `--help`
failures disappeared after the required clean rebuild, confirming they came from
ignored stale `dist` output rather than current source.

Of the 785 skips, 777 are conditional integration or platform tests: 730 AI tests
require real provider API, OAuth, cloud, local-model, or network availability, and
47 coding-agent tests require provider credentials or Windows. The remaining eight
are documented Xiaomi upstream limitation probes: four aborted-stream usage tests
and four mixed text-plus-image tool-result tests. They remain as explicit FIXME
contracts for periodic upstream retesting; they are not counted as passing product
behavior and should not be deleted merely to reduce the default skipped count.

The public CLI verifier reported 57 passed, zero skipped, and zero failed. Its
distribution, release, CI, YAML/action, shell syntax, shellcheck, and diff policy
checks also passed. MagentaPackages reported 26/26 workflow and artifact security
tests, 5/5 Cardiomni runtime tests, 9/9 PantheonOS contract tests, 26/26 Pixi runtime
tests, and 368 passed plus 32 explicitly ignored Rust tests with zero failures;
package validation found six packages and 62 skill entrypoints. The Cardiomni test
dependency lock file is part of the local Package commit. The verified Cardiomni
branch was then fast-forwarded into the local Package `main`; remote `main` remains
unchanged, so no package tag or publication can occur until a later reviewed push.

Rebuilt and installed binaries matched the repository's active version identity.
Four-platform construction produced the expected Mach-O arm64, Mach-O x64, ELF
Linux x64, and PE Windows x64 executable formats. Both compiled macOS targets
materialized and executed the three helper classes expected for their architecture
from fresh isolated homes; the arm64 binary also passed `--version` and the complete
`--help` path. The local macOS binary passed strict ad-hoc code-signature
validation; it is not a public Developer ID signature. Isolated native, npm,
and Bun installations all reported the active product version and passed
`--help`.
Temporary local-release products were removed after verification; their hashes
are not reused as release evidence. A formal release must record final hashes in
its source-bound manifest and signing receipt.

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

The final local release verification removed its temporary output, and
the repository contained no `.bun-build` scratch file afterward. The release
workflow's temporary compiled clipboard probe now uses the same finally-cleaned
Bun wrapper as every supported product compile, with a static regression test
that rejects future direct `bun build --compile` calls in that workflow.

The repository contains static Windows installer transaction checks plus native
Linux, macOS, and Windows workflow recovery fixtures. The source Actions jobs did
not start, so current-source native crash-recovery evidence remains pending. The
old deliberate Unix installer gate has been replaced by the source-owned
transaction and its fail-closed native smoke jobs; publication still waits for
those jobs, real Developer ID signing/notarization, and the external Actions
blockers described above.
