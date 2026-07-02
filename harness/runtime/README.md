# Runtime Providers

`runtime://process` is a TypeScript port of the portable guardrail portion of
Magenta1 `general-harness/kernel/src/runtime_provider.rs`.

It enforces the direct-exec gate, workspace cwd, environment allowlist, wall
clock timeout, declared filesystem read/write checks, and network tag/allowlist
checks. OS-level sandbox backends (`sandbox-exec`/`bwrap`) are intentionally not
claimed here; that remains a separate hardening step.
