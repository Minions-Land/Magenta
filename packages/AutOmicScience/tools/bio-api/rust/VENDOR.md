# Vendored: aose-bio-mcp

This directory is a **vendored, trimmed** copy of the bio-database MCP server
from the AutOmicScience (BioAgent) Rust workspace. It was brought in because the
upstream BioAgent repository is being retired; the `aose-bio-mcp` binary that
the `bio_api` package tool spawns must build independently inside Magenta3.

## Origin

- Source repo: https://github.com/Minions-Land/AutOmicScience
- Source commit: `8964a637123fa9caa8f30baf6bb8bc1bb6b8b0bc`
- Vendored: 2026-07-05

## What was copied (and what was dropped)

The dependency closure was mapped before copying. Only the minimal set needed to
serve the bio tools over MCP/stdio was vendored:

| Crate | Origin | Notes |
|---|---|---|
| `aose-schemas` | `crates/aose-schemas` | leaf, copied verbatim |
| `aose-bio-apis` | `crates/aose-bio-apis` | leaf, copied verbatim (24+ DB clients) |
| `aose-core` | `crates/aose-core` | **trimmed** to the tool subsystem: `tool.rs`, `trait_based_tool.rs`, `types.rs`, `error.rs` + a slim `lib.rs` |
| `aose-mcp` | `crates/aose-mcp` | **trimmed** to `server.rs` (stdio server); the MCP client + its reqwest/SSE deps dropped |
| `aose-bio-mcp` | `crates/aose-tools/src/bio_typed.rs` + `crates/aose-cli/src/bin/aose-bio-mcp.rs` | new crate hosting the bio tool set + the binary |

Deliberately **not** vendored (the tool subsystem never references them):
`aose-tools` (providers/runtime/workflow/omics/bridge), the non-tool `aose-core`
modules (agent/protocol/provider/memory/subagent/result_collector/utils), and
their heavy transitive deps (tokio-postgres, rusqlite, redis, mongodb, reqwest
via the MCP client).

## Build

```bash
cargo build --release --bin aose-bio-mcp
```

The resulting binary is `target/release/aose-bio-mcp`. The package descriptor
`../bio-api.toml` points its `command` at that path.

## Re-syncing from upstream

If upstream changes before full retirement, re-copy the five source paths above
and re-run the build gate. The only local modifications are the trimmed
`aose-core/src/lib.rs`, the trimmed `aose-mcp/src/lib.rs`, the new
`aose-bio-mcp/src/lib.rs`, the `aose_tools::` → `aose_bio_mcp::` rename in the
binary, and the vendored workspace `Cargo.toml` (shared-dep table).
