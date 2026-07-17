# Reproducing the PI v0.80.8 upgrade ledgers

Run from the Magenta repository root. File hashes are read directly from Git blobs, not mutable export directories.

Default evidence repositories and refs:

- `PI_UPSTREAM_REPO=/tmp/magenta-pi-upstream-v0.80.8-20260717`
- `MAGENTA_REPO=<repo>`
- `PI_U2_SHA=0201806adfa825ab3d7957a4267d46e5030fd357`
- `PI_U8_SHA=fae7176cb9f7c4725a40d9d481d8d70b80f18086`
- `MAGENTA_IMPORT_SHA=f1da4c98bd3b8df522a0e80e2f6e6bfcdb064328`
- `MAGENTA_CURRENT_SHA=e7a6e770385e2c6ca16888f7ed5a97bd38bdb39e`

Each value can be overridden with the environment variable shown above. The validator asserts that upstream tags `v0.80.2` and `v0.80.8` resolve to the fixed SHAs and that both Magenta commits exist before hashing any file.

Regenerate and validate in this order:

```bash
node docs/research/pi-v0.80.8-upgrade/scripts/build-semantic-index.mjs
node docs/research/pi-v0.80.8-upgrade/scripts/build-commit-ledger.mjs
node docs/research/pi-v0.80.8-upgrade/scripts/build-file-triage.mjs
node docs/research/pi-v0.80.8-upgrade/scripts/build-wave-map.mjs
node docs/research/pi-v0.80.8-upgrade/scripts/validate.mjs --write-result
```

The generators overwrite only report artifacts in the parent directory. `build-commit-ledger.mjs` derives direct versus dependency edges from the current evidence section and includes explicit parent-review bindings for the four ungrouped MX commits plus cross-cutting CU-026/HC-009 governance rows. `validate.mjs` independently recomputes commit metadata and status/path payloads from Git, hashes every four-way coordinate from fixed Git objects, asserts the six exact rename coordinates, verifies semantic/canonical-action/wave-map foreign keys, checks dependency order and validates README links. It does not execute PI or HCP runtime tests; those are implementation gates, not static-plan validation.
