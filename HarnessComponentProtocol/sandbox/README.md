# Sandbox Profiles

Magenta1 sandbox profiles migrated from `general-harness/components/providers/sandbox`.

This module provides profile discovery, lookup, and the `hook://sandbox-select`
selection rule in TypeScript for Magenta3 assembly/HCP management. It does not
yet enforce the runtime sandbox. Magenta1 enforcement lived in
`kernel/src/runtime_provider.rs`; that remains a separate migration step.
