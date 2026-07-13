# Ultra Mode Contract

1. Ultra is a Magenta execution profile, not a provider/API thinking value. No provider request receives `ultra`.
2. Selecting Ultra maps the current model to its highest supported native thinking level (`max`, otherwise `xhigh`, `high`, etc.).
3. Ultra appears as the highest user-facing option in the thinking-level cycle and is persisted/restored independently from the mapped native level.
4. Ultra gives the input editor a rainbow border while preserving theme compatibility, terminal width correctness, focus, IME cursor behavior, and bash-mode precedence.
5. Ultra enables full multi-agent orchestration by default: `sub_agent` workflow presets and persistent `teammate_agent` collaboration. Ordinary profiles keep one-shot headless `sub_agent` available but do not expose workflow orchestration or managed teammates by default.
6. Harness configuration can enable workflow and teammate capabilities for non-Ultra profiles, and can disable either capability in Ultra; Ultra supplies defaults rather than an unoverrideable policy.
7. Capability gating is structural at the tool schema/execution layer, not prompt-only. One-shot sub-agent actions remain functional when workflows are disabled.
8. Profile changes update the active tool/runtime surface and TUI immediately, survive session resume, and do not change the selected model.
9. Tests prove provider-native mapping, cycle/persistence, capability overrides, workflow/teammate gates, rainbow rendering, and unchanged ordinary sub-agent behavior.
