# Policy Providers

The `policy` Harness Module is an experimental, explicit-selection provider for
approval decisions and shell classification. It is not autoloaded and the
default coding-agent tool path does not consult or enforce its decisions.
`HcpServer.ts` owns the policy addresses and operations; `magenta/HcpMagnet.ts`
builds providers adapted from Magenta1 `approval_provider.rs` and
`shell_policy_provider.rs`.

These providers return policy decisions and classifications only. They do not
prompt the user or execute shell commands. The application owns interaction,
while an explicitly connected runtime owns command execution and enforcement.
Selecting the Module makes it available for explicit HCP dispatch; it does not
turn it into a coding-agent security boundary.
