# Magenta Process Tools

Rust process tools migrated from Magenta1 `general-harness/bins/process-tools`.

The binary reads one JSON object from stdin and prints a text result to stdout.
`ProcessToolMagnet` uses the TOML manifests under `harness/tools/process/` to
wrap these commands as Magenta3 `AgentTool`s.

Source/provenance:

- origin: `magenta1-general-harness`
- relationship: `migrated/adapted`
- original path: `/Users/mjm/Magenta/general-harness/bins/process-tools`
