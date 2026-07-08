# Progress — HCP Unification

## Status

✅ Phase 0 — unified assembler [DONE, 8/8 tests, harness 353/353 green, tsc clean]  
✅ Phase 1 — compaction via HCP [DONE, harness 353/353 + pi compaction 29/29 + resource-loader 36/36 green; rebuild harness dist after source edits]  
✅ Phase 2 — built-in tools via magnets [DONE, pi 1631/1631 + harness 353/353 green; NativeToolMagnet resolves read/bash/edit/write/grep/find/ls via session HCP; renderKind + promptSnippet/promptGuidelines/renderCall/renderResult merged from pi canonical for byte-identity; show tool stays pi-local]  
✅ Phase 3 — resources [DONE, decision (b) recorded: system-prompt stays RESOURCE, context stays pi-owned loadProjectContextFiles (harness ContextProvider has different discovery semantics → routing would break INV-5.2), skills/prompt-templates pure resources; content/code segregation principle documented; zero code change]  
✅ Phase 4 — hooks reconciliation [DONE, pi 1633/1633 green; ExtensionRunner.setHcp caches HookProvider (INV-3), _invokeLifecycleHook delegates pre-tool/post-tool/pre-llm/post-llm; harness HookProvider is DECLARATIVE (returns action plans, no side effects) so Phase 4 discards results = byte-identity; golden hook-order test + fallback test added]  
✅ Phase 5 — policy/sandbox/runtime [DONE, pi 1636/1636 green; capabilities were assembled-but-unconsumed; added _resolve{Policy,Sandbox,Runtime}Provider + cached fields in _buildRuntime (INV-3); RESOLVED not enforced — policy defaults to yolo (allow-all no-prompt), shell advisory-only, sandbox not-ported, so C5.2/C5.3 byte-identity holds; kept pi local spawn (NOT rerouted through runtime:process which would change env scoping); enforcement is opt-in future work; 3 parity tests added]  
✅ Phase 6 — menu + cleanup [DONE, harness 353/353 + pi 1636/1636 green; C6.3 fixed agent-harness.ts packagesRoot: cwd bug → getHarnessPackagesRoot(cwd), demoted Runtime A with header comment (kept public export + 4 tests); verified all 7 tool wrappers delegate to create*Execute (no reimpl); C6.1/C6.2 added "Live HCP" inspect node calling describeAll() on the running session HCP (17 targets: 6 tools + 11 caps), inspect-only + separated from existing toggle rows which stay untouched for parity]

## ✅ ALL PHASES COMPLETE — HCP unification done. All harness content routes through ONE session HcpClient (INV-1), byte-identical output (INV-5.2), hot path off HCP (INV-3).

## Iteration log

### Iteration 0 — contract + discovery (2026-07-08)

- Loaded research-orchestration skill
- Read HCP contract files (hcp-magnet.ts, hcp-server.ts, hcp-client.ts)
- Verified chain: LLM → HcpClient → HcpServer → HcpMagnet → harness source
- Analyzed tool duplication (pi wrappers already import harness logic layer)
- Spawned adversarial contract reviewer (agent_001, 3m22s)
- **Critic findings**: 12 gaps (8 blocking), verdict GO-WITH-FIXES
- Revised contract v2 with all 12 fixes incorporated
- Key discoveries:
  - pi ALREADY assembles HCP (`assemblePackageToolMagnets`) but never consumes it (orphaned)
  - `getPackageHcp()` exists on class but not interface
  - `CAPABILITY_KINDS` excludes system-prompt & multiagent despite having magnets
  - packagesRoot mismatch between Runtime A (`cwd`) and Runtime B (`resolve(repoRoot,"packages")`)
  - pi compaction already satisfies `CompactionProvider` contract

**Next**: implement Phase 0 (unified assembler + resolution test).

### Iteration 1 — Phase 0 implemented (2026-07-08)

- Created `harness/hcp-client/assembly/session-hcp.ts` — `buildSessionHcp()`
  merges built-in tool magnets + default capabilities + package overlay into ONE
  HcpClient. packagesRoot derived via `getHarnessPackagesRoot` (fixes finding #12
  packagesRoot divergence).
- Created `harness/test/session-hcp.test.ts` — 8 tests, all green.
- Exported `buildSessionHcp` from `harness/index.ts`.
- **Real harness bug found + fixed**: `NativeToolMagnet.toHcpServer()` did not
  implement `instance()`, so `assemblePackageToolMagnets`' own tool-extraction
  (`target.instance?.()`) would silently drop native tools. Added `instance()`
  returning the built AgentTool — now tool + capability resolution is uniform.
- **Corrections to critic findings** (verified by runtime probe of registered
  addresses):
  - Findings #2/#6 were PARTLY WRONG: `system-prompt` AND `multiagent` ARE
    assembled by `buildDefaultCapabilityHcp` (they have magnets in
    CAPABILITY_SOURCE_MAGNETS). The critic conflated the overlay's
    `CAPABILITY_KINDS` set (which excludes them) with the capability assembler
    (which includes them). buildSessionHcp registers 11 capability addresses.
  - `runtime` is multi-slot: `capability:runtime:process` +
    `capability:runtime:script-runtimes` (no bare `capability:runtime`).
- Verify: harness `npx vitest --run` = 43 files / 353 tests pass; tsc -p
  tsconfig.build.json --noEmit = exit 0. Zero consumer files changed (C0.3).

**Next**: Phase 1 — wire pi to consume compaction from a session HCP via
`resolveCapability("compaction")` instead of the direct import.
