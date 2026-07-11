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
