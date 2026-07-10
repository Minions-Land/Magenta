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

The Harness package build runs this command and copies the resulting binary
into `dist/_magenta/process-tools/target/release/` beside the
shipped manifests.

Source/provenance:

- origin: `magenta1-general-harness`
- relationship: `migrated/adapted`
- original path: `/Users/mjm/Magenta/general-harness/bins/process-tools`
