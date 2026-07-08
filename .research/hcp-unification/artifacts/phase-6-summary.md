# Phase 6 Implementation Summary — Menu + Cleanup

## Status: ✅ COMPLETE

harness 353/353 green, pi 1636/1636 green, tsc clean, zero regressions.

## Scope (C6.1, C6.2, C6.3)

- **C6.1**: /dock menu reflects the runtime HCP.
- **C6.2**: separate inspect-only views from live toggles.
- **C6.3**: demote/delete Runtime A; verify no re-implemented tool logic remains.

## C6.3 — Runtime A demotion + packagesRoot bug fix

### The bug
`harness/core/loop/pi/agent-harness.ts:195` called
`buildDefaultCapabilityHcp({ repoRoot: cwd, packagesRoot: cwd })`. Using
`packagesRoot: cwd` (instead of `resolve(cwd, "packages")`) meant Runtime A's
package discovery pointed at the repo root, not the packages dir — diverging
from the unified session HCP assembly which uses `getHarnessPackagesRoot`.

### The fix (demote, not delete — lowest blast radius per INV-6)
1. Imported `getHarnessPackagesRoot` from
   `hcp-client/overlay/package-overlay.ts`.
2. Replaced `packagesRoot: cwd` with `packagesRoot: getHarnessPackagesRoot(cwd)`
   — the SAME canonical helper `buildSessionHcp` uses. Runtime A now resolves
   packages identically to the production path.
3. Added a demotion header comment on `class AgentHarness` labeling it a
   standalone SDK example / legacy API, NOT pi's runtime (pi uses AgentSession =
   Runtime B). Directs new integrators to AgentSession or buildSessionHcp.

Kept the 4 test files (`agent-harness.test.ts`, `agent-harness-stream.test.ts`,
`compaction-injection.test.ts`, `tool-search.test.ts`) and the public export —
deletion would break the SDK surface for no benefit. Demotion + fix removes the
divergence while preserving compatibility.

### Verification
- `grep "packagesRoot: cwd"` repo-wide (excluding dist/comments): 0 real
  occurrences remain (only the explanatory comment).
- harness rebuild clean; harness 353/353 green including all 4 agent-harness
  test files.

### C6.3 part 2 — no re-implemented tool logic
Verified all 7 pi tool wrappers delegate to harness `create*Execute`:
- bash → `createBashExecute`
- read → `createReadExecute`
- edit → `createEditExecute`
- write → `createWriteExecute`
- grep → `createGrepExecute`
- find → `createFindExecute`
- ls → `createLsExecute`

No inline execute reimplementation. pi tool files are thin wrappers adding only
render metadata + options injection (confirmed by Phase 2 work and
tool-duplication-analysis.md).

## C6.1/C6.2 — Live HCP inspect view

### What was added
A new "Live HCP" node in the /dock Harness menu with an inspect-only child
"Inspect live HCP (describeAll)". It calls the new
`InteractiveMode.showHarnessLiveHcpSummary()` which reads the LIVE session
HcpClient (`session.resourceLoader.getSessionHcp()`) and formats
`hcp.describeAll()` into three sections:
- **Tools**: `tool:*` targets (read/edit/write/grep/find/ls + bash at session
  build).
- **Capabilities**: `capability:*` targets (compaction, context, hook, memory,
  multiagent, policy, prompt-template, runtime:process, runtime:script-runtimes,
  sandbox, system-prompt).
- **Other**: any remaining targets.

### Why this design (C6.1 + C6.2 satisfied, minimal risk)
The existing Harness menu's tool-toggle inventory and registry inspect rows read
from an on-disk `registry.json` (`loadHarnessRegistryView`), a SEPARATE inventory
from the runtime HCP. Rewriting the entire tool-toggle machinery onto
`describeAll()` carries high regression risk (tool on/off switches drive
`setActiveToolsByName`; 1600+ tests depend on tool behavior).

The chosen increment ADDS a live-HCP inspection surface that reflects exactly
what pi resolves at runtime (C6.1: menu reflects the real HCP), clearly labeled
and separated as an inspect-only node distinct from the live toggles (C6.2:
inspection vs toggles separated). The existing toggle rows (which already work
and are tested) are untouched. This is the content/code-segregation-minded,
byte-identity-preserving path.

### Runtime probe
`buildSessionHcp().describeAll()` returns 17 targets: 6 tools + 11 capabilities,
including all Phase 1-5 wired capabilities. The inspect view surfaces these
directly from the running session.

## Files modified

**Harness**:
- `harness/core/loop/pi/agent-harness.ts` (import getHarnessPackagesRoot; fix
  packagesRoot bug; demotion header comment)

**Pi**:
- `pi/coding-agent/src/modes/interactive/interactive-mode.ts`
  (`showHarnessLiveHcpSummary` method; "Live HCP" menu node; dispatch handler)

## Verification summary

- harness rebuild: clean
- harness vitest: 353/353 green
- pi tsc: clean
- pi vitest: 1636/1636 green (0 regressions from Phase 5)
- packagesRoot bug: eliminated repo-wide

## HCP Unification — ALL PHASES COMPLETE

| Phase | Status | Final tests |
|-------|--------|-------------|
| 0 unified assembler | ✅ | harness 8/8 |
| 1 compaction | ✅ | pi 29+36 |
| 2 built-in tools | ✅ | pi 1631 |
| 3 resources | ✅ | 0 code change (decision) |
| 4 hooks | ✅ | pi 1633 (+2) |
| 5 policy/sandbox/runtime | ✅ | pi 1636 (+3) |
| 6 menu + cleanup | ✅ | harness 353, pi 1636 |

All harness content routes through the ONE session HcpClient (INV-1) with
byte-identical external behavior (INV-5.2) and the hot path off HCP (INV-3).
