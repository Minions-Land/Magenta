# Magenta Process Tool Runtime

Rust process tools migrated from Magenta1 `general-harness/bins/process-tools`.

The binary reads one JSON object from stdin and prints a text result to stdout.
It is shared host support, not a Harness Module: each real tool Module keeps its
own `HcpServer`, source-local `HcpMagnet`, and process manifest, while the
manifest selects one subcommand from this binary.

Build the single release binary with:

```sh
npm run build:process-tools --workspace @magenta/harness
```

The Harness package build runs this command and copies the prepared binary
into `dist/_magenta/process-tools/target/release/` beside the shipped
manifests. Cargo output is authoritative when Cargo is available. If Cargo
cannot be found, the build stages the checked-in prebuilt for the current
supported platform instead. A Cargo command that starts but fails still fails
the build, so compiler errors cannot be hidden by an older prebuilt.

`target/release` is the canonical binary in Node/source development and is
preferred over `prebuilt`. Bun-compiled releases continue to extract and hash
verify their embedded platform binary before installing it into the runtime
resource tree.

The checked-in Linux x64 prebuilt is a static
`x86_64-unknown-linux-musl` executable. Release checks reject a Linux helper
that has a `PT_INTERP` segment or versioned `GLIBC_` symbols, so the helper does
not inherit the GitHub runner's glibc baseline. The immutable build workflow
writes `prebuilt/SHA256SUMS`; release builds verify that receipt before
embedding any helper.

Source/provenance:

- origin: `magenta1-general-harness`
- relationship: `migrated/adapted`
- original path: `general-harness/bins/process-tools`
