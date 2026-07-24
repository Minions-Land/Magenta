# Changelog

All notable changes to Magenta CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Source-owned `install.sh` is now a versioned, checksummed Release asset; Unix installs use a self-contained payload root plus an atomic PATH link, transactionally repair proven damaged or binary-less installations, safely migrate owned flat layouts, and provide an idempotent ownership-checked uninstall that preserves user settings, messages, and sessions
- The release workflow now pins one source-owned Apple Team ID, performs explicit inside-out Developer ID signing for embedded macOS helpers, the universal clipboard binding, and both Bun executables, submits both architectures to Apple notarization, proves the compiled executables materialize those exact signed helpers, and publishes a source-bound signing receipt as the tenth durable Release asset
- Long-running sub-agent and workflow work has no implicit one-hour deadline when timeout is omitted; explicit deadlines share one validated Node timer range, and persistent teammate RPC commands allow five minutes without limiting Session lifetime
- Machine-global peer mailboxes now migrate unread inbox messages, unsettled relay outbox payloads and delivery ledgers, offline Session ownership, and endpoint on/off state from the legacy agent-local database; verified target imports commit before source settlement, and the source remains available for late writes from old versions

### Changed
- Workflow workers now require a valid successful `run_end`, a terminal assistant result, a clean process exit, and schema-valid structured output; classification, ranking, tournaments, loops, and fan-out presets propagate invalid or failed workers instead of silently choosing fallback winners or reporting completion
- Default workspace tests now reject missing, stale, or ghost compiled output with a clean-build instruction, clear ambient provider credentials, and disable implicit local-model probes; real-provider compatibility checks require the explicit `npm run test:e2e` command
- Experimental HCP policy, lifecycle-hook, and session-grounding memory providers are no longer autoloaded or presented as connected enforcement, while the retained sandbox/runtime metadata now states its actual portable-guard scope for explicit process-backed consumers rather than implying OS isolation or universal native-tool coverage
- Diagnostic output for background shells, sub-agents, workflows, teammates, and opt-in cache telemetry now has private permissions plus finite per-file, file-count, age, and total-size retention; high-frequency main-tool progress updates are coalesced to one trailing write per second
- Workflow state created by a configured sub-agent runtime now stays under its private agent state root; low-frequency cleanup refuses foreign-owned, linked, changed, live, locked, or malformed artifacts, including stale wake sockets, empty orphan teammate registries, and expired or over-capacity MCP tool-cache entries
- Session listing now uses a bounded metadata index and validates file identity before serving cached rows; first-message previews and search text are bounded by UTF-8 bytes (head and tail are retained, so the middle of an oversized message is intentionally omitted)
- Session, settings, trust, and migration state now uses bounded regular-file reads and private atomic replacements; concurrent session-grounding writes serialize through the durable store instead of exposing partial JSONL or metadata
- MCP package assembly receives an explicit host cache root, while helper generations, package staging directories, and lock/temporary residue are cleaned only after ownership, liveness, and identity checks
- Streaming sub-agent, workflow, teammate RPC, background-shell, and retained bash full-output logs now batch small chunks for up to 100 ms or 64 KiB while keeping live status and tails immediate, reducing disk-write frequency without losing output at completion, cancellation, timeout, failure, or shutdown
- Harness eval output now streams into private, size-bounded artifacts; truncated streams invalidate the result, oversized structured plans and summaries fail before file creation, while age, file-count, and total-size cleanup preserves active runs and never follows symlinks
- Harness eval summaries now distinguish contract validity, execution success, scorer status, and comparison-evidence eligibility; fixed-order runs sharing one environment and a single repetition are diagnostic only and cannot pass as A/B evidence
- Release preparation now always replaces ignored build output with a clean offline build before version validation, checks, tests, packaging, or publication; every supported Bun compile removes abandoned scratch executables on both success and failure, local archives are rebuilt and verified file-for-file from complete staged resources, prior archives survive replacement failures, incomplete automatic output is removed, and failed explicit `--out` output is retained with a marker
- Completed local macOS binaries are ad-hoc re-signed and strictly verified before archival; public macOS assets still require Developer ID signing and notarization
- SSH gossip relays stay alive independently of an interactive Session, use endpoint locks instead of relay PIDs for ownership, and adopt a newly installed executable generation after the current lock owner exits
- SSH relay endpoint locks now refresh their filesystem lease every 20 seconds and expire after 60 seconds, cutting steady-state lock-metadata writes in half while preserving a bounded crash-takeover window and mixed-version ownership safety
- Harness Package release artifacts are deterministic across rebuilds, and package publication now accepts only a new tag on verified `main`, stages an exact private draft, verifies all eight remote sizes and SHA-256 digests, and publishes only after that complete contract passes

### Fixed
- `/login` now discovers provider-owned API-key and OAuth methods from the current `ModelRuntime`, including extension OAuth providers, and routes persistence plus catalog refresh through that single owner; successful login keeps the repaired menu focus, keyboard, paste, callback, and remote-catalog behavior, while cancellation leaves prior credentials unchanged and logout preserves environment or read-only external credentials
- Main-agent, side-chat, compaction, and branch-summary requests now dispatch through their session-scoped `ModelRuntime`, so providers sharing one API cannot capture each other's transport and one session reload cannot reset another; session factories also honor `PI_OFFLINE`, failed catalog refreshes retain the last snapshot with visible diagnostics, and normal startup still permits catalog refresh
- Session switch, new-session, persisted fork, and import flows now prepare their replacement runtime before shutting down the current session, so creation or setup failure leaves the existing session usable without emitting a false shutdown
- Release builds now fail immediately when any required staged resource or `photon_rs_bg.wasm` is missing or cannot be copied instead of suppressing the copy error
- macOS release helper verification now securely creates its isolated cache tree under a completely fresh user home before materializing signed helpers, while still rejecting linked, foreign-owned, or group/world-writable ancestors
- Self-update and runtime-resource repair now bound release metadata through complete JSON consumption, enforce one 15-minute asset-download deadline across retries and backoff in addition to the inactivity timer, reject declared or streamed payloads above 512 MiB, and remove only partial files created by the failing attempt
- Compiled releases now materialize process-tools, fd, and ripgrep under owner-controlled SHA-256-addressed immutable cache paths; HCP process manifests bind to the current process's exact helper generation instead of a cross-version target that another installation can replace
- GitHub Harness Package acquisition now gives artifact/checksum retries one shared 15-minute deadline plus a 2-minute inactivity bound, streams at most 512 MiB/1 MiB, rejects oversized, sparse, linked, or non-portable archives, and binds cache hits to an owner-controlled, single-link, bounded digest of the actual package tree; invalid direct caches repair beside the active path, unrelated residue cannot hide a valid repair generation, and excessive generations fail closed without another download
- Failed but unpublished source tags no longer deadlock the next release: an explicit exact-version recovery can advance only after verifying the older public baseline and the immutable remote tag's ancestry and embedded product version
- Native clipboard bindings are loaded only on first use after compiled runtime repair, so a repaired installation works in the current process and Windows does not lock a stale addon before transactional replacement
- `/reload` now respawns the canonical compiled Magenta executable with only user arguments, instead of treating Bun's virtual argv entry as the program to launch
- Rolling mailbox upgrades no longer hand outbound messages to transit-only v0.0.29 peers whose age-based retention cannot guarantee custody; upgraded durable peers recover ambiguous forwarded payloads without echoing ingress traffic or retrying terminal rejections, and orphan deduplication markers can no longer produce false custody acknowledgements
- Harness evals now refuse real runs before model calls or result creation when any requested component is unknown, non-boolean, undeclared in an arm, unvaried across a comparison, or cannot map to executable isolation; failed arms and unexecuted scorers can no longer produce a successful runner result
- The default system prompt no longer embeds the wall-clock date, preserving provider prompt-cache prefixes across midnight while still allowing HCP callers to supply an explicit date
- Tools activated during a tool call now reach the next provider request in the same run, and additive run-scoped system-prompt overrides are rebased onto the new tool prompt without retaining stale tool guidance
- API keys imported from Codex and Claude Code now carry their explicitly active local or proxy base URL into the actual Anthropic, Google, and OpenAI provider request; Codex configurations without `model_provider` no longer guess an endpoint from inactive provider tables
- Ambient and Claude Code `ANTHROPIC_AUTH_TOKEN` credentials now reach Anthropic requests with Bearer authentication, and Codex ChatGPT OAuth access tokens are no longer misrouted to the public OpenAI API as API keys
- Codex and Claude Code configuration and credential files are now strict read-only sources: credential discovery plus Magenta login and logout modify only Magenta's own auth store and leave those external files unchanged
- Magenta credential mutations update in-memory state only after the private auth file is atomically persisted under its lock; parse and persistence failures remain visible to login, logout, and OAuth refresh callers instead of appearing successful
- Windows installation and binary self-update now use an isolated offline staged startup to initialize and verify process-tools while keeping plain `--help` read-only; self-update atomically replaces and rolls back the version-matched `_magenta` helper tree and rejects architectures with no published binary
- Binary self-update and startup resource repair now use a private, durable transaction journal and one installation lock, recover interrupted staging or rollback work before any new activation, and keep the executable path atomically populated across Unix and Windows replacement; journal v6 binds every original path and staged resource object to its exact filesystem identity, binds the staged binary by SHA-256, and refuses to overwrite a replacement that appeared before rollback. Rollback claims are discoverable after a process crash, retained backups prove completed file or directory publication before cleanup, and a terminal journal is written before any rollback artifact is removed
- Release transactions now record install and remove-only resource sets separately; valid prior-release ownership markers automatically retire managed resources omitted by a new archive, while v1-v5 journals remain recoverable and every Unix, resource-only, and Windows rollback restores those retired paths safely
- Unix resource extraction now discards archived numeric ownership, so privileged installs stage files as the installing user and can pass the updater's ownership checks
- Compiled Bun relays now remove Bun's virtual executable entry from successor arguments, so an installed-binary handoff relaunches `_peer relay` instead of accidentally entering the ordinary CLI
- The standalone Windows installer now shares the built-in updater's per-installation lock, durably journals every activation phase, atomically replaces `magenta.exe`, restores or safely completes interrupted binary/resource transactions on the next run, and refuses install or uninstall mutation when `InstallDir` contains unmanaged top-level data
- Linux process-tools CI now fails explicitly when a release binary gains an interpreter or glibc dependency instead of relying on negated pipelines that bypass shell errexit
- Idle gossip polling no longer takes a SQLite write lock when a peer has no claimable outbox work, identical relay state/error updates are write-free, and bounded hourly maintenance removes only read inbox rows, acknowledged relay payloads, and inactive deduplication history without aging out unread or unacknowledged messages
- Gossip session advertisements now use a stable member set and reconcile peer routes by set difference, while unchanged presence records retain their original timestamp instead of appending WAL frames; presence liveness matches an OS process-start identity to reject PID reuse, and explicit bounded orphan cleanup preserves every live Session, registry reference, unread/pending inbox row, and unsettled outbox payload
- Mixed-version mailbox supervisors no longer overwrite an active relay's executable generation or trust a reusable PID without its endpoint lock; relays hand off to the installed executable after releasing the lock, while retained legacy stores import late inbox and outbox writes without a commit-to-delete data-loss window
- Legacy mailbox migration now rebases transit envelopes to the machine-global store identity, restores missing locally originated senders as offline ownership, and rolls back the complete target import without settling source rows when federation metadata is malformed
- SSH mailbox links now resolve an explicit `--remote-binary` or the remote non-interactive shell's installed Magenta path, retain bounded SSH startup diagnostics, restart both relay and responder processes after executable replacement, and retry failed lock handoffs without requiring another interactive Session
- Internal teammate RPC traces suppress cumulative token-level message updates, avoiding quadratic pipe, memory, and disk amplification during long responses
- Concurrent teammate readiness settlement and hard-interrupt scheduling now share one generation-bound abort request, preventing duplicate abort RPCs or duplicate replacement delivery
- Workflow workers now terminate with an explicit failure when one NDJSON frame, retained assistant history, or stderr exceeds the shared diagnostic byte cap, preventing timeout-free workflows from exhausting parent-process memory
- Background-shell and persistent-teammate cleanup now protects only genuinely open or foreign-live logs, so repeated work in one long-running Magenta process cannot bypass file-count, age, and total-size retention
- Opt-in cache telemetry now uses process-isolated active logs to avoid cross-process rotation races, retires each Session's active log on shutdown so long-lived processes remain subject to retention, and reports unsupported provider payload shapes as `unclassified_payload` instead of a false cache-miss cause
- `magenta --version` and plain `--help` return before migrations, settings, updates, or embedded-resource repair, so metadata probes do not write to the user profile or access the network
- Legacy `~/.pi/agent` state migration now copies into a private staging directory and atomically publishes only a complete result; update-check timestamps, auth state, and Harness caches use bounded secure reads plus private atomic writes and refuse symbolic-link destinations
- Release publication now requires a complete changelog section for the exact release version and fails before publishing when release notes are missing, empty, or still represented only by `Unreleased`
- Formal release commands now reject an unconfigured source-owned Apple Team ID before changing version files, creating commits, tagging, or pushing
- Windows detached self-update helpers now bind their exact PID and OS creation time to the durable transaction journal while the parent still holds the install lock; live matching helpers block recovery, reused PIDs remain recoverable, and PowerShell refuses journals that do not identify itself

### Security
- Public-source preparation now exports only a clean, owner-reviewed, allowlisted current snapshot into a new one-root-commit local repository; digest-pinned legal/package/binary/interoperability gates plus built-in and gitleaks scans prevent copying private history, refs, audit evidence, credentials, backups, or unreviewed content, and the tool never creates a remote or pushes
- macOS release signing now validates Apple certificate and notarization credentials into memory, removes every configured `MAGENTA_*` signing variable before resource staging or any signing child process, and preserves unrelated process environment values
- Release candidates now remain private Actions artifacts until signing and every native smoke gate pass; only then may publication create or resume a draft whose `SOURCE_COMMIT`, exact ten-asset set, sizes, and GitHub SHA-256 digests match one single-read immutable local snapshot, with the exact remote set checked again after publication while published or mismatched drafts fail closed for manual audit
- The downstream public verifier now pins its Apple Team ID in reviewed repository source, verifies the private source's exact annotated tag through a dedicated read-only token, downloads Windows assets by immutable API ID with streaming limits, and runs both native macOS architectures to bind all six materialized helper bytes and signatures to the signing receipt; source publication refuses to proceed unless the two repositories' trust files match exactly
- Destructive binary and local-release output replacement rejects repositories, ancestors, unowned directories, marker symlinks, and parent-symlink path escapes, then revalidates the canonical destination immediately before deletion
- Release publication now waits for native Linux, macOS arm64, macOS Intel, and Windows smoke jobs plus fail-closed macOS signing and source-owned Unix-installer hand-offs; every staged macOS Mach-O must carry a valid Developer ID signature, the outer binaries must also pass Apple notarization and Gatekeeper checks, and only an exact source-bound partial draft may resume while a published or mismatched same-tag release remains untouched
- Downloaded release binaries, bundled process-tools, and detached update helpers are verified in a minimal environment without arbitrary user secrets, and public asset downloads never send GitHub Authorization tokens to GitHub assets or configured mirrors
- Source, distribution, and package workflows default to read-only permissions, remove checkout credentials from Git configuration, and run verifier policy tests on ordinary pull requests and pushes; write access is scoped only to draft-verification and draft-publication jobs that fail closed on an existing Release

## [0.0.29] - 2026-07-21

### Security
- Pinned patched transitive releases for brace-expansion and protobufjs to remove their published denial-of-service advisories

## [0.0.28] - 2026-07-21

### Fixed
- Linux releases embed a static musl process-tools helper instead of requiring the build host's newer glibc symbols
- Self-update executes the staged process-tools helper before atomic replacement so loader or ABI failures preserve the existing installation
- Self-update retries Bun transport failures reported as closed sockets, unavailable connections, or generic fetch failures

### Security
- Release checks require exact SHA-256 receipts for process-tools, fd, and ripgrep prebuilts, and every GitHub Actions dependency is pinned to a commit

## [0.0.27] - 2026-07-20

### Added
- Durable SSH peer federation now floods messages across relays with per-link acknowledgements and retries, deduplication, bounded hop and advertisement frames, scheduled retention maintenance, mixed-schema compatibility, and automatic reconnect
- An opt-in tok.fan billing calibration harness compares persistent Claude Code and Magenta sessions with randomized sequential pairing, consume-log attribution, finite-token quota enforcement, redacted reports, and dry-run defaults
- Extension entry renderers can display persisted session entries in interactive mode without adding them to model context

### Changed
- The upstream runtime through Pi v0.80.8 is integrated behind the ModelRuntime provider and credential facade while Magenta's independent workspace package versions remain at 0.80.2
- Background, peer, sub-agent, workflow, and reminder completions share one turn-boundary activation coordinator, and claimed external turns participate in the same idle and settled lifecycle as user prompts
- Provider usage is normalized into disjoint input, output, cache-read, cache-write, one-hour cache-write, and reasoning subsets for consistent context telemetry and cost calculation
- `Shift+Tab` continues to expose Magenta's `ultra` execution profile while translating it to each provider's highest native effort instead of sending a literal `ultra` value
- When auto-compaction is enabled, model switching compacts with the current model before committing a smaller target and rejects the switch if the fresh compacted transcript still exceeds that target

### Fixed
- Bun release binaries load packaged clipboard native bindings from explicit platform resource paths, and release archives now require every published macOS, Linux, and Windows binding
- External activation quiescence yields to turn-barrier release instead of busy-looping, terminal sub-agent receipts retain deterministic registration order independent of completion timing, and asynchronous settled handlers remain part of the host-visible busy lifecycle
- Automatic compaction locks model switching before credential resolution and uses one immutable model/authentication snapshot through summarization
- Mixed-version peer links negotiate gossip transit support so legacy V1 peers continue direct delivery without permanently consuming unsupported transit messages, while bounded deduplication retention removes expired `peer_seen` state without deleting active delivery protection
- Anthropic zero-value deltas no longer erase cumulative cache/input usage, Google reasoning stays an output subset, and Bedrock one-hour cache writes retain their distinct pricing tier

### Security
- Billing calibration isolates child environments, rejects ambiguous consume-log attribution, and requires a dedicated finite-quota tok.fan token plus an explicit real-spend confirmation before live execution
- Release jobs validate and serialize immutable semantic-version tags, pin every action by commit, install the lockfile without lifecycle scripts, verify clipboard native tarballs against committed SHA-512 integrity, build checked-in model catalogs offline, and bind the installer, source commit, and all artifacts to one checksum receipt through Windows smoke testing and publication

## [0.0.26] - 2026-07-19

### Changed
- Single tool calls now render through the same activity gallery as multi-tool turns (batch=1), eliminating dual rendering paths and providing a consistent visual frame for all tool executions

### Technical Notes
- bg_shell returns already wake idle agents when delivery is not "nextTurn" (idlePolicy: "activate")
- Multiple bg_shell returns within 50ms automatically batch into a single context injection via ExternalActivationCoordinator
- Tool execution group component simplified: removed singleComponent() special case, unified rendering through renderToolCallActivity

## [0.0.25] - 2026-07-19

### Fixed
- Tool descriptions now match system prompt: `sub_agent` clarifies "Magenta worker", `send_message` includes delivery semantics, and `multiagent` parameter descriptions improved for model clarity
- OpenRouter pricing updated for Claude 3.7 Sonnet
- `magenta update self` (and the deprecated `magenta --update`) no longer aborts mid-download on slow or unstable connections: release-asset downloads now use a 2-minute inactivity timeout that resets on each received chunk instead of a fixed 5-minute overall deadline, retry up to three times with backoff on transient network/abort errors, and surface a clear stall message that points to `MAGENTA_GITHUB_MIRROR` instead of the opaque "The operation was aborted."

## [0.0.24] - 2026-07-18

### Changed
- Multi-agent work is split into three HCP-owned Tools: singular finite `sub_agent` Events with automatic terminal activation, persistent Session-id lifecycle through `multiagent`, and atomic durable mailbox acceptance through `send_message`; the old `teammate_agent`, Assignment, batch, and blocking-wait surfaces are removed
- Persistent teammates now keep durable desired/observed process state, recover only for the exact Main Session lineage under a 16-process FIFO limit, read Main Todo through a mandatory read-only projection, and use versioned Git worktree receipts for explicit integration or discard
- Extension command contexts no longer expose the deadlock-prone `waitForIdle()` API; extensions inspect `isIdle()` and continue deferred work from `agent_end`, and RPC abort requests now acknowledge immediately

### Fixed
- Custom session entries appended during assistant streaming now render before the live assistant message, matching persisted session order
- Background shell cancellation and timeout now remain nonterminal until the owned process exits (or an adopted execution reports completion), so automatic terminal delivery cannot release a work lease while the command may still be writing
- Interactive prompts can be withdrawn with Escape or Ctrl+C until the first renderable assistant text, thinking, or tool call; withdrawal restores the submitted draft and removes its user/aborted-assistant turn from agent state, session JSONL, and TUI history without a three-second deadline or `Operation aborted`
- CLI release commands now version the active product brand, finalize only the coding-agent changelog, use annotated tags and lease-protected pushes, restore pre-commit failures, and reject unrelated file changes without modifying independent Pi package versions or refreshing online model catalogs

## [0.0.23] - 2026-07-16

### Security
- The public `sub_agent` workflow schema no longer exposes or accepts model-authored inline JavaScript; trusted programmatic script workflows remain internal to the Harness

### Fixed
- Source builds prefer freshly compiled process-tools, fall back to the checked-in platform binary only when Cargo is unavailable, and stop the root workspace build at the first failed package
- Multi-agent `sub_agent` start results wrap footer text to the available terminal width instead of returning embedded newlines that can crash the TUI
- The TUI contains malformed or over-width ordinary frame lines across first, full, and differential renders, preserves image and cursor control sequences, and leaves render caches unchanged when strict validation fails
- Tool activity galleries, floating windows, rich-content links, and narrow animated components keep every physical output line within the requested width
- `sub_agent` starts honor abort and shutdown barriers, enforce the eight-worker limit atomically, isolate controller files, and report workflow timeout, startup, log, and outcome failures accurately
- `sub_agent` cancellation and timeout keep their soft lease until the child or workflow actually settles, and automatic returns are independently cancellable per event
- Background stdout and stderr preserve independent UTF-8 state across process chunks, compiled Bun builds flush empty decoders safely, and terminating or disposed background work no longer produces premature or permanently blocked quiescence
- One-shot Harness process execution no longer leaks an unhandled `EPIPE` when a successful child exits without reading stdin

## [0.0.22] - 2026-07-15

### Fixed
- Closed the `bg_shell` input schema so removed wait actions and wait-timeout settings are rejected instead of silently ignored
- Windows PowerShell installation now captures startup stdout and stderr independently with a bounded process lifetime, allowing expected first-run bootstrap diagnostics without failing or hanging the installer

## [0.0.21] - 2026-07-15

### Changed
- Removed the model-facing blocking `bg_shell wait` action and its wait-timeout settings; background completions now return through the external-activation coordinator, while `status` remains an immediate snapshot and headless settlement keeps its separate bounded runtime wait

### Fixed
- Process-tools bootstrap diagnostics now use stderr so first-run standalone JSON/RPC stdout remains strict machine-readable JSONL

## [0.0.20] - 2026-07-15

### Added
- One `ExternalActivationCoordinator` now coalesces background completions, peer and teammate mail, and stall reminders into atomic priority batches with persistence receipts, cancellation, shutdown rollback, and headless quiescence
- Manual and automatic compaction hold external activation delivery until summarization finishes, then release one post-compaction batch without injecting background output into the compaction request
- Managed editing teammates support session-scoped Git worktrees, immutable terminal receipts, clean-parent integration as unstaged changes, confirmed discard, preserved shutdown state, and binary/symlink/mode-aware change capture
- Side/BTW conversations now persist per main session with a history picker, multiline and bracketed-paste editing, scoped clipboard copy, and a confirmed human-only handoff that invites a managed teammate without creating an assignment or ownership lease
- Binary-only users can load trusted compiled HCP Tool, Capability, and Resource packages through the existing HcpClient/HcpServer/HcpMagnet assembly path
- A machine-readable Ultra/headless eval contract validates manifests, workflow and teammate tool evidence, process/background settlement, and bounded execution for future SWE-bench drivers

### Changed
- Deterministic base system-prompt composition is owned by the HCP `system-prompt` capability while Pi retains resource discovery and extension lifecycle mutation; missing required HCP slots now fail explicitly
- Sub-agent workflows and managed teammates use the current CLI entrypoint instead of a possibly stale `magenta` on `PATH`, and RPC state exposes effective capabilities and active tools after execution-profile changes
- Collaboration guidance now distinguishes one-shot workers, workflows, persistent teammates, urgent peer mail, active soft leases, structured terminal receipts, and non-overlapping edit ownership
- Todo supports multiple simultaneous `in_progress` branches with an optional focused current item, and the TUI renders parallel work without a redundant Current row
- Background activity, collaborator telemetry, reminders, and direct `bg_shell` rendering are separated into user-visible side channels without adding telemetry to model context
- Refreshed generated OpenRouter model pricing and context metadata

### Fixed
- Pressing Escape within three seconds of an interactive submission restores its text and attachments only for an eligible user abort, without restoring after output, timeout, retry, shutdown, or compaction
- External activation races no longer lose or duplicate work across queued delivery, compaction, inline consumption, shutdown, nested delivery barriers, or a claimed host racing an already-starting run
- Managed teammate startup cleans up an unspawned session, log, and provisioned worktree after a synchronous process failure; `model = "default"` now inherits the parent model when no provider is specified
- Magenta self-update, version reporting, release discovery, and failure diagnostics use Magenta branding and release channels rather than Pi package resources

## [0.0.19] - 2026-07-14

### Changed
- `send_message` now delivers **always urgent**: every peer message steers the recipient's next tool-calling turn and wakes an idle recipient immediately. The `urgent` parameter has been removed from the tool schema — teammate coordination is time-sensitive by nature, so a low-priority/follow-up mode is no longer offered. (Previously messages were normal/follow-up by default and `urgent: true` had to be set explicitly.)

### Fixed
- The Windows installer remains ASCII-compatible with Windows PowerShell 5.1, and the release workflow now rejects installer syntax errors before smoke installation
- Standalone installers and the built-in updater now authenticate mirrored payloads with direct GitHub API digests or an official checksum manifest fetched outside the third-party mirror, preventing a mirror from replacing both an artifact and its claimed checksum
- `/clear` now starts a fresh session exactly like `/new`; previously only the bare `clear` alias was normalized, so the documented slash form could fall through as a normal prompt
- `magenta --update` now surfaces the actual reason when the release check fails instead of a bare "Could not fetch latest release": non-404 GitHub API responses, rate-limit exhaustion (with reset time and a `MAGENTA_GITHUB_TOKEN` hint), and network errors are all reported, and `--update` prints targeted follow-up tips (set a token, check direct API connectivity, or reinstall via the install script when a checksum/verification failure indicates a pre-v0.0.12 binary)
- A failed release check no longer records a successful update-check timestamp, so transient network failures do not suppress the next check for 24h
- `docs/USER_INSTALL.md` and `docs/CHINA_NETWORK.md` document update-failure troubleshooting: old-binary incompatibility, rate limits, and API-reachability diagnosis

## [0.0.18] - 2026-07-14

### Added
- Long-running `bash` commands are promoted to a background `bg_shell` event after a 3s inline deadline instead of blocking the agent loop; the same child process keeps running across promotion, and the promoted event auto-returns its completed result to the main agent
- `bg_shell` and `sub_agent` gain `returnToMain` (default true), `returnDelivery` (`steer`/`followUp`/`nextTurn`, default `followUp`), and `returnInstruction` parameters, plus `config` defaults; a terminal `wait`/`status` on an event cancels its pending automatic return so results are never delivered twice
- Completed background returns are coalesced: near-simultaneous `bg_shell`/`sub_agent` completions batch into one delivery while the session is idle and deliver immediately while it is streaming, and any pending batch is flushed at turn boundaries
- The Todo tool gains a `reset` operation that archives a fully completed plan into a running `history`, with a `/todo` overlay that switches between Current and History (Tab), opens an archived plan (Enter), and returns from detail (Escape); version-1 Todo snapshots migrate to the history-aware v2 shape automatically
- Opt-in prompt-cache telemetry (`PI_CACHE_TELEMETRY=1`) records per-request cache fingerprints and outcomes as JSONL for local cache-efficiency analysis, and Anthropic cache diagnostics (`PI_CACHE_DIAGNOSTICS=1`) surface `anthropic_cache_miss` reasons with missed-token counts
- Compaction accepts an optional `maxContextFraction` (0 < fraction ≤ 1) that caps the effective context budget below the model's raw window

### Changed
- Migrated the TypeScript toolchain to the native TypeScript 7 (7.0.2) compiler across every workspace; type-checking and builds run through the native `tsc`, with the classic Compiler API served by the `@typescript/typescript6` compatibility package for the scripts that need it
- Long OpenAI session identifiers are hashed into a bounded `prompt_cache_key` (≤ 64 characters) so cache affinity is preserved without exceeding provider limits

### Fixed
- `EventStream` propagates terminal failures to all waiting async iterators instead of leaving them pending

## [0.0.17] - 2026-07-13

### Added
- Headless mode gains a versioned JSON/RPC protocol emitting `runtime_manifest` (startup readiness with resolved model, resources, and policies), `non_interactive_ui` (blocking-UI dispositions), and `run_end` (turn statistics) events; `docs/headless-protocol.schema.json` publishes the draft 2020-12 contract
- `--background-policy <cancel|wait|error>` controls how leftover background work (sub-agents, bg-shell) is settled when a one-shot run finishes, with `--background-wait-timeout <seconds>` (default 60) bounding the `wait` deadline
- `--non-interactive-ui <deny|error>` enforces non-blocking extension UI in headless contexts, and `--validate-config` performs a dry-run of model, auth, and resource resolution without calling the model
- `Dockerfile.headless` and `.dockerignore` provide a multi-stage container build running as an unprivileged user under `tini`, with three documented deployment patterns in `docs/containerization.md`
- TUI incremental rendering: a `StaticPrefixContainer` caches the immutable history prefix and re-renders only the mutable tail, and markdown gains a per-token render cache keyed by a structural fingerprint for smoother streaming; `bench/render-performance.ts` validates the gain
- `MarkdownOptions.preserveOrderedListMarkers` keeps author-supplied ordered-list numbering instead of normalizing it

### Changed
- `RpcClient` waits on the runtime manifest for a deterministic readiness handshake and derives feature detection from the manifest instead of a fixed startup delay
- Refreshed generated OpenRouter pricing and context metadata

### Fixed
- GPT-5 context-window overrides are covered by tests documenting the OpenAI 272k/372k caps versus the 1M ceiling reported by Azure and OpenRouter

### Added
- GitHub mirror support via the `MAGENTA_GITHUB_MIRROR` environment variable, which rewrites every GitHub URL (self-update, harness package acquisition, and `fd`/`rg` helper-tool downloads) through a proxy prefix for restricted networks; unset preserves the previous direct-download behavior
- macOS/Linux install script auto-detects `aria2c` for 16-connection parallel downloads and falls back to `curl`, and the Windows `install.ps1` now honors `MAGENTA_GITHUB_MIRROR`
- New `docs/CHINA_NETWORK.md` guide covering mirror selection, `aria2` setup, manual verified downloads, and troubleshooting

## [0.0.15] - 2026-07-13

### Added
- Ultra input border now animates a flowing rainbow that shifts one palette step per frame while preserving ANSI escapes, grapheme clusters, and column width, and stops when Ultra is inactive, in Bash mode, suspended, or the terminal is externally owned
- Clipboard image pastes render `[paste #N Image]` markers whose identity is snapshotted across editor swaps and carried through prompt, steer, follow-up, and post-compaction replay queues

### Fixed
- Windows `install.ps1` now implements the documented `-NoPath` and `-Uninstall` switches, including user-PATH entry removal
- Editor undo can no longer resurrect cleared paste markers, and images whose markers were removed from the submitted text are dropped instead of leaking into a later turn
- `clearImageTokens()` cancels pending clipboard scan timers so their callbacks cannot fire against a cleared controller
- Widened premature-stream-close retry classification to cover both Anthropic and OpenAI stream endings

## [0.0.14] - 2026-07-13

### Added
- Ultra execution profiles map to each model's highest supported native reasoning level and enable workflow orchestration plus persistent teammates by default, with CLI, settings, SDK, RPC, session-resume, and TUI support
- The new `teammate_agent` tool manages persistent child sessions with start, status, send, interrupt, stop, and resume controls, parent lineage, parent-only mailbox routing, and shutdown cleanup
- Todo is now a Magenta-owned hierarchical plan with atomic batch operations, branch-aware state restoration, compact inline rendering, and a dedicated `/todo` overlay
- Compaction exposes bounded progress phases and chunk metrics to SDK and TUI consumers

### Changed
- Standard execution profiles retain one-shot sub-agents while workflow schemas and persistent teammates remain capability-gated; nested workers strip recursive coordination tools
- Incoming peer messages carry an explicit agent-provenance envelope for the model without changing their TUI presentation
- Refreshed generated OpenRouter and Vercel AI Gateway pricing and context metadata

### Fixed
- Replayed assistant messages for OpenAI Responses omit the response-only `status` field, preventing strict models from rejecting conversation history
- Managed teammate delivery now composes parent-only filtering with owner-aware claims, count limits, and byte limits without starving authorized work

## [0.0.13] - 2026-07-13

### Added
- MCP servers can connect through Streamable HTTP with JSON or SSE responses, session recovery, bounded request bodies, strict redirect handling, and credential-safe diagnostics
- Workflow workers accept Harness package selectors as shared defaults or per-worker overrides, including from the compiled Magenta binary
- The TUI MCP menu now reflects loaded servers, tools, and connection diagnostics dynamically

### Changed
- All shipped and loaded tools are enabled by default while HCP remains able to switch the active set without rebuilding the binary
- Sub-agent, background-shell, peer-message, and MCP model-visible results are byte-bounded while complete logs and Ctrl+O snapshots remain available
- Send Message drains at most 10 messages and 32 KiB per turn, with a 24 KiB per-message limit and owner-aware pending claims for at-least-once delivery
- Dynamic OpenRouter routers display unknown cost until the provider reports a concrete charge, including workflow aggregation and HTML exports

### Fixed
- Long-running provider streams no longer inherit the HTTP idle timeout as a whole-request deadline when switching between Claude and OpenAI models
- Queue clearing requeues pending teammate messages instead of leaving live-owner claims stranded
- Required model catalog generation now fails closed and publishes generated files atomically; optional NVIDIA validation failures preserve the previous catalog
- Release builds now rebuild the Harness declarations before compiling binaries, and Windows smoke tests cover PowerShell 5.1, PowerShell 7, cross-drive installation, and Git Bash startup
- MCP notification-body stalls, legal SSE line endings, oversized responses, session expiry races, and stripped Authorization credential echoes are handled safely

## [0.0.12] - 2026-07-12

### Added
- HCP-isomorphic v2 packages can be acquired from verified GitHub release artifacts and loaded through the shared resource pipeline

### Changed
- Package role modules now use content-derived cache keys, so TUI reloads observe edited HcpServer and HcpMagnet files without restarting Magenta

### Fixed
- Legacy v1 package manifests, grouped components, and scalar default profiles now pass through the compatibility layer instead of being rejected as malformed v2 packages
- Binary self-update now verifies the platform executable and runtime resource archive from the same GitHub release, then switches both together with rollback on Unix and Windows
- A newly updated binary now repairs missing or version-mismatched runtime resources before theme or HCP initialization, including upgrades performed by older binary-only updaters
- Concurrent self-updates only skip an installed release when its runtime resources and marker are complete, while older transactions cannot overwrite a newer incomplete release
- Windows installation and self-update reject unsafe or colliding archive paths, preserve drive roots, and stage replacements on the destination volume

## [0.0.11] - 2026-07-12

### Added
- Added a PowerShell 5.1-compatible Windows installer that downloads version-matched runtime resources, verifies SHA-256 checksums, validates startup, and updates the user PATH
- Release publication now waits for Windows PowerShell 5.1 and PowerShell 7 startup smoke tests, including a cross-volume install when the runner exposes a second filesystem drive

### Fixed
- Windows Bun binaries now recognize `~BUN` and `%7EBUN` virtual module URLs, so HCP runtime paths resolve beside `magenta.exe` instead of attempting to create the filesystem root (`\`)
- Windows installation now stages beside the destination for same-volume replacement, allowing downloads from a C: temporary directory to install safely on D: with rollback of the previous installation on failure
- PowerShell 5.1 installation no longer attempts to recreate an existing drive root when the selected install directory is directly below it

## [0.0.9] - 2026-07-12

### Changed
- All native application tools (`read`, `bash`, `edit`, `write`, `bg_shell`, `sub_agent`, `send_message`, `show`, `grep`, `find`, `ls`) are now active by default; `show`/`grep`/`find`/`ls`/`send_message` no longer require explicit `--tools` opt-in. The default active set is now a single source of truth (`DEFAULT_NATIVE_ACTIVE_TOOLS`) shared by the SDK and interactive session paths, so the two can no longer drift apart

### Fixed
- Send Message now records `idle` presence at session construction (right after the wake handler is installed), closing a startup blind window where a freshly launched session had no presence row and was invisible to peers — an urgent message could neither see it as idle nor wake it, silently falling back to mailbox-only delivery
- The HCP `find` and `grep` Magnets now wire the embedded `fd`/`rg` resolvers, so HCP-resolved `find`/`grep` work in a clean environment instead of failing on a missing `ensureTool` dependency or a missing system `rg`
- OpenAI Responses reasoning-item replay now guards against non-JSON thinking signatures with try/catch instead of a bare `JSON.parse`, so a stale or malformed signature drops just that reasoning item instead of failing the whole request during construction

### Security
- Bumped `shell-quote` to `^1.8.4` (from 1.8.3) in the sandbox example extension and `undici` to `^6.27.0` (from 6.26.0) in the gondolin example extension via `overrides`, resolving 5 Dependabot alerts (1 critical shell-quote newline escaping, 1 high undici WebSocket DoS, 1 medium undici Set-Cookie header injection, 2 low undici)

## [0.0.8] - 2026-07-12

### Added
- Sub-agents can be granted Harness package selectors, including shared defaults and per-task overrides
- The `/skill:` command dock now opens the loaded Skills menu directly, filters as the user types, and backfills the selected skill for additional instructions

### Changed
- Sub-agent and background-shell returns now show a compact status by default and reveal full metadata and output with `Ctrl+O`
- Embedded `process-tools`, `fd`, and `rg` runtime support now lives under the host-owned `_magenta` boundary instead of the closed HCP protocol layer

### Fixed
- Automatic compaction now checks context usage between tool turns using provider usage plus newly produced tool results
- Context overflow responses containing `Context window is full` now trigger compact-and-retry recovery
- Manual and automatic compaction split oversized histories into bounded incremental summaries instead of sending an overlong summarization prompt
- Repeated idle Send Message wakes are coalesced into one agent turn while preserving every persisted message
- Embedded helper lookup no longer depends on the current working directory, and upgrades replace stale `process-tools` binaries by content hash
- Unified Magenta update tests now exercise the current Git/release dispatch path

## [0.0.7] - 2026-07-11

### Major Improvements
- **TUI update notifications for all users**: binary installation users now see update banners with release notes
- **100% English localization**: all remaining Chinese strings translated

### Added
- Created `unified-update-check.ts` to support both Git checkout and binary installation update detection
- TUI now shows update banners for binary users with release notes preview and instructions
- Added `handleReleaseUpdateStatus()` to display GitHub Release updates in TUI

### Changed
- Enhanced tool parameter descriptions to prevent LLM confusion:
  - `show` tool: explicitly states parameter name is `url` (not `path`)
  - `send_message` tool: clarified parameter is `content` (not `message`)
  - `bg_shell`/`sub_agent`: clarified parameter is `eventId` (not `id`)
- Split `checkAndAutoUpdateMagenta()` into specialized handlers for Git vs Release updates

### Fixed
- Binary users no longer see "Auto-update: unavailable" - now shows actual update status
- Translated remaining Chinese strings in `github-release-update.ts` and `main.ts --update`

## [0.0.6] - 2026-07-11

### Major Improvements
- **All tools work out of the box**: embedded `fd` and `rg` binaries, achieving 100% tool availability
- **Automated release pipeline**: GitHub Actions builds and publishes releases automatically

### Added
- Embedded 4-platform prebuilt binaries for `fd` (v10.2.0) and `rg` (v14.1.1)
- Created `embedded-tools.ts` to unify embedded distribution of fd/rg/process-tools
- Added GitHub Actions release workflow for automated publishing
- Build-time check script verifies binary integrity for all tools (process-tools/fd/rg)

### Fixed
- Fixed the `find` tool missing its `fd` binary
- Fixed the `grep` tool missing its `rg` binary

### Changed
- Cleaned up README.md, removing references to upstream projects
- Updated install instructions to use the one-line script and GitHub Releases
- Binary size increased by ~30MB (fd ~10MB + rg ~20MB)

### Tool Availability
| Version | Working Tools | Broken Tools | Availability |
|------|---------|---------|-------|
| v0.0.4 | 10/25 | 15 | 40% |
| v0.0.5 | 22/25 | 3 (find/grep/lsp) | 88% |
| **v0.0.6** | **25/25** | **0** | **100%** |

## [0.0.5] - 2026-07-11

### Major Improvements
- **Embedded single-file distribution**: bundled the 4-platform `magenta-process-tools` binary into the main executable
- **Automatic extraction**: first run extracts the binary to `~/.magenta/cache/process-tools/`
- **Zero-config, works out of the box**: all core tools (bash/read/write/edit/grep/web-search) require no extra setup

### Added
- GitHub Actions CI for automated 4-platform cross-compilation
- Pre-build check script that verifies all platform binaries are ready
- Embedded binary manager handling extraction, caching, and path resolution

### Fixed
- Fixed all platforms missing the `magenta-process-tools` binary
- Fixed incorrect `HCP_ROOT` path resolution under the Bun-compiled runtime
- Fixed the install script not downloading the runtime resource bundle

### Changed
- Cleaned up the changelog, removing historical entries from unrelated upstream history
- Resource bundle shrank from 4MB to 3.8MB (process-tools now embedded in the main binary)
- Binary size increased to 114-147MB (includes 4 embedded platform copies of process-tools)

## [0.0.4] - 2026-07-11

### Fixed
- Fixed v0.0.3's missing HCP component resources in the packaged build
- Fixed a startup crash: `ENOENT: sandbox/sandbox.toml`
- Improved the install script to support platform-specific resource bundles

### Known Issues
- Platforms other than macOS arm64 were missing a prebuilt `magenta-process-tools` binary
- Some core tools (bash/read/write/edit/grep/web-search) could fail to run

## [0.0.3] - 2026-07-10

### Fixed
- Fixed the release package missing Harness Component Protocol resources

### Known Issues
- All platforms failed to start due to missing sandbox/tools/policy/runtime resources

## [0.0.2] - 2026-07-09

### Added
- Four-platform binary releases (macOS arm64/x64, Linux x64, Windows x64)
- One-line install script
- Basic functionality verification

## [0.0.1] - 2026-07-08

### Added
- Initial release of Magenta CLI
- Multi-model support (Google, Anthropic, OpenAI, and more)
- Interactive TUI mode
- File operation tools (read, write, edit, bash, grep)
- Session management and history
- Sub-agent and background task support
- Skill system (paper-analysis, pptx, research-orchestration)
