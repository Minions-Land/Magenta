# Hooks

The `hooks` Harness Module is an experimental, explicit-selection lifecycle
provider. It is not autoloaded into default coding-agent sessions.
`HcpServer.ts` owns discovery and calls; `magenta/HcpMagnet.ts` builds the
provider adapted from Magenta1 `general-harness/kernel/src/hook_provider.rs`.

The provider returns declarative action/data envelopes. It does not directly
execute session, memory, approval, shell, or workflow targets. The host decides
when to consume and route those actions through the session `HcpClient`.

When explicitly selected, coding-agent currently calls the `pre-llm`,
`post-llm`, `pre-tool`, and `post-tool` phases, but it does not execute returned
actions. The `init`, `pre-turn`, `compact`, and `workflow` phases have no
coding-agent caller. Until typed consumers exist, these envelopes provide no
default lifecycle, context, or enforcement effect.
