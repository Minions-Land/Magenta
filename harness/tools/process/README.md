# Process Tool Manifests

Magenta1 process-tool manifests migrated into the Magenta3 harness layout.

Each TOML file describes one process-backed tool. The common command target is
`process-tools/target/release/magenta-process-tools`, resolved relative to the
`harness/` package root by `ProcessToolMagnet`.

These manifests are not duplicate TypeScript tools. They are the Rust-backed
variants used for capabilities such as hashline reads, AST grep/edit planning,
fuzzy path search, URL read, web search, and LSP-style queries.
