# Sandbox Profiles

The `sandbox` Harness Module owns profile discovery, lookup, and selection.
`HcpServer.ts` exposes `sandbox://*` and `hook://sandbox-select` addresses;
`magenta/HcpMagnet.ts` builds the provider from the checked-in profile TOML.

The Module does not spawn or isolate processes itself. Selected profile values
are consumed by `runtime://process`, which currently enforces portable path,
environment, timeout, and network guards. The `sandbox-exec`/`bwrap` OS backend
from Magenta1 is not ported, and runtime policy reports `os_enforced: false`.

The profiles and selection rules were adapted from Magenta1
`general-harness/components/providers/sandbox`; they remain configuration for a
real runtime boundary, not a separate execution path.

That boundary applies only when a caller explicitly resolves both `sandbox` and
`runtime:process`. Current consumers include HCP process-backed tools, stdio MCP
servers, package process tools, and script-runtime wrappers. Native pi tool
implementations and arbitrary child processes that bypass those capabilities
are outside this boundary. The portable checks therefore must not be described
as OS isolation or as universal enforcement across every coding-agent tool.
