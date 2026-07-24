# Runtime Providers

The `runtime` Harness Module owns the `runtime:process` and
`runtime:script-runtimes` capability slots. Its `magenta` Source provides
`runtime://process` plus shell, Python, Node, R, and Julia wrappers compiled to
that process boundary.

`runtime://process` is a TypeScript port of the portable guardrail portion of
Magenta1 `general-harness/kernel/src/runtime_provider.rs`. It enforces the
direct-exec gate, workspace cwd, environment allowlist, wall-clock timeout,
declared filesystem read/write checks, and network tag/allowlist checks.

The current policy report explicitly returns `os_enforced: false`. OS-level
backends such as `sandbox-exec` and `bwrap` are not implemented, so portable
guards must not be documented as equivalent to an operating-system sandbox.

The guards run only for callers that explicitly resolve `runtime:process` (and,
where applicable, a `sandbox` profile). Current product consumers are HCP
process-backed tools, stdio MCP servers, package process tools, and
script-runtime wrappers. Native pi tool implementations and other direct child
processes are not automatically routed through this provider, so this Module is
not a universal coding-agent command-enforcement layer.
