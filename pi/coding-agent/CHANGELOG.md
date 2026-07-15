# Changelog

All notable changes to Magenta CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed
- Removed the model-facing blocking `bg_shell wait` action and its wait-timeout settings; background completions now return through the external-activation coordinator, while `status` remains an immediate snapshot and headless settlement keeps its separate bounded runtime wait

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
