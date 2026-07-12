# Changelog

All notable changes to Magenta CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed
- Binary self-update now verifies the platform executable and runtime resource archive from the same GitHub release, then switches both together with rollback on Unix and Windows
- A newly updated binary now repairs missing or version-mismatched runtime resources before theme or HCP initialization, including upgrades performed by older binary-only updaters

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
