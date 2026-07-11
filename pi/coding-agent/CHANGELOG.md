# Changelog

All notable changes to Magenta CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
