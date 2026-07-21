# fd runtime asset

This directory contains the platform-specific `fd` binaries embedded in
Magenta release builds. It is host runtime support under `_magenta`, not an HCP
module or protocol role.

Provenance:

- upstream: <https://github.com/sharkdp/fd/releases/tag/v10.2.0>
- version: `10.2.0`
- targets: Apple Darwin arm64/x64, Linux x64 musl, Windows x64 MSVC
- license: `MIT OR Apache-2.0` (declared by upstream `Cargo.toml`)
- receipt: `prebuilt/SHA256SUMS`

All four checked-in executables were compared byte-for-byte with their
corresponding upstream release archives on 2026-07-21. That upstream release
provides neither checksum assets nor GitHub API asset digests, so the checked-in
receipt records the bytes retrieved from the official release over TLS.
