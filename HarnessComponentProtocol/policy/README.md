# Policy Providers

The `policy` Harness Module provides approval and shell-classification
Capabilities. `HcpServer.ts` owns the policy addresses and operations;
`magenta/HcpMagnet.ts` builds providers adapted from Magenta1
`approval_provider.rs` and `shell_policy_provider.rs`.

These providers return policy decisions and classifications only. They do not
prompt the user or execute shell commands. The application owns interaction,
while the runtime owns command execution and enforcement.
