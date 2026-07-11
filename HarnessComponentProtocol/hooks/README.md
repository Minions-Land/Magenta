# Hooks

The `hooks` Harness Module provides the selected lifecycle-hook Capability.
`HcpServer.ts` owns discovery and calls; `magenta/HcpMagnet.ts` builds the
provider adapted from Magenta1 `general-harness/kernel/src/hook_provider.rs`.

The provider returns declarative action/data envelopes. It does not directly
execute session, memory, approval, shell, or workflow targets. The host decides
when to consume and route those actions through the session `HcpClient`.
