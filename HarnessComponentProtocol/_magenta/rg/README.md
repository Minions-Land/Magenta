# ripgrep runtime asset

This directory contains the platform-specific `rg` binaries embedded in
Magenta release builds. It is host runtime support under `_magenta`, not an HCP
module or protocol role.

Provenance:

- upstream: <https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1>
- version: `14.1.1`
- targets: Apple Darwin arm64/x64, Linux x64 musl, Windows x64 MSVC
- license: `Unlicense OR MIT` (declared by upstream `Cargo.toml`)
- receipt: `prebuilt/SHA256SUMS`

All four checked-in executables were compared byte-for-byte with their
corresponding upstream release archives on 2026-07-21. Each archive also
matched its upstream `.sha256` asset before comparison.
