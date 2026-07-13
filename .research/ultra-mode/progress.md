# Ultra Mode Progress

- [x] Contract and external/local implementation research
- [x] User-facing execution profile distinct from provider-native thinking
- [x] Highest supported native thinking-level mapping
- [x] CLI, model suffix, SDK, RPC, settings, and session persistence
- [x] Workflow schema/execution gating
- [x] Persistent teammate registry gating and live shutdown
- [x] Harness settings and SDK override precedence
- [x] Static theme-derived rainbow editor border
- [x] Focused profile, capability, persistence, RPC, and TUI tests
- [x] Documentation and Harness status visibility
- [x] Final focused verification and package build

Provider requests never receive the literal `ultra`; `Agent.state.thinkingLevel` remains native. Standard profiles retain one-shot `sub_agent` tasks. Ultra defaults workflows and teammates on, while explicit `harness.workflows`, `harness.teammates`, or SDK `harnessCapabilities` values win in either direction.

Verification: 241 focused coding-agent tests, 691 TUI tests, 8 HCP worker-safety tests, targeted Biome, `git diff --check`, and the coding-agent package build pass. The repository-wide coding-agent run remains non-green because 46 unrelated tests are concurrently failing in model-catalog, Harness package/resource, compaction, and auth fixtures owned by another active session.
