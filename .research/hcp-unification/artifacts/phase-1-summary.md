# Phase 1 Artifacts — Compaction via HCP (INV-1)

## Goal
Route pi's compaction impl through the ONE session HcpClient
(`resolveCapability("compaction")`) instead of the static
`import { compact as harnessCompact } from "@magenta/harness"`.

## Key identity that makes this behavior-identical
```
hcp.resolveCapability("compaction")
  → compactionPiMagnet.build()          (sources.ts)
  → piCompactionProvider                (provider.ts)
  → { compact, prepareCompaction }      (= the SAME functions pi imported as
                                          harnessCompact/harnessPrepareCompaction)
```
So injecting the HCP-resolved provider vs. the static import calls the identical
underlying function — injection only changes the resolution PATH (import → HCP
chain), not behavior.

## Files modified
1. `harness/hcp-client/assembly/session-hcp.ts`
   - Added `packageHcp?: HcpClient` option (mutually exclusive with `overlay`):
     lets a caller that ALREADY assembled the overlay layer default capabilities
     on WITHOUT a second MCP-spawning `assemblePackageToolMagnets` pass.

2. `pi/coding-agent/src/core/resource-loader.ts`
   - Imported `buildSessionHcp`, `HcpClient`.
   - Added `getSessionHcp?(): HcpClient | undefined` to the `ResourceLoader`
     interface (optional — null loaders/test doubles may omit).
   - Added `private sessionHcp?` field + `getSessionHcp()` on
     `DefaultResourceLoader`.
   - In `loadHarnessPackageResources`: build the session HCP in BOTH branches —
     the no-package branch (default capabilities only) and the package branch
     (default capabilities layered on the already-assembled `assembly.hcp` via
     `packageHcp:`). Reset `sessionHcp` on reload.

3. `pi/coding-agent/src/core/compaction/compaction.ts`
   - `prepareCompaction(..., provider?)` and `compact(..., provider?)` now accept
     an optional injected `CompactionProvider`; when omitted they fall back to the
     static harness function (backward-compatible). Auth (`createCompactionModels`)
     and `unwrap` (throw-on-error) semantics unchanged — those are pi transport
     concerns, correctly kept in pi.

4. `pi/coding-agent/src/core/agent-session.ts`
   - Imported `CompactionProvider`, `HcpClient`.
   - Added `_resolveCompactionProvider()` — resolves `capability:compaction` from
     `resourceLoader.getSessionHcp()`. Returns undefined when no HCP → wrappers
     fall back to static default (identical behavior).
   - Threaded the resolved provider into BOTH compaction call sites (manual
     `compact()` at ~1888/1935, auto-compaction at ~2164/2217).

## generateSummary note
Pi's `generateSummary` wrapper is NOT on `CompactionProvider` and has NO runtime
caller (only a doc comment + a public re-export in index.ts). Left importing the
static harness `generateSummary` — out of scope for INV-1 (not a loop-consumed
capability).

## Verification
- harness `npx tsc -p tsconfig.build.json --noEmit`: exit 0
- pi `npx tsc --noEmit`: no NEW errors (2 pre-existing unrelated: bg-shell.test
  eventData, tui/src/utils es2024 regex flag — confirmed present on baseline via
  git stash).
- harness full suite: 353/353 green (43 files).
- pi tests: `compaction` 25 (2 skip) + `compaction-summary-reasoning` 6/6 +
  `resource-loader` 36/36 (incl. new Phase-1 test) pass.

## ⚠️ Build-order gotcha (cost one debugging cycle)
`@magenta/harness` resolves via a node_modules symlink to `harness/`, whose
`package.json` sets `"main": "./dist/index.js"`. Pi's vitest therefore imports
the BUILT dist, NOT harness source. After ANY harness source change you MUST run
`npm run build` in `harness/` before pi tests will see it — otherwise you get a
runtime `X is not a function` for the new export while tsc stays green (tsc reads
`.d.ts` from a path map, vitest reads compiled JS). This bit Phase 1: the new
`buildSessionHcp` export was invisible to pi until the rebuild.

## Consumer-facing invariants held
- INV-1: compaction impl resolved through HCP, not static import (at the loop
  consumer — agent-session). The pi transport wrapper still references the static
  fn only as a fallback default for loaders without an HCP.
- INV-2: still ONE HcpClient per session (the loader's `sessionHcp`).
- Backward compatibility: `getSessionHcp` optional; provider param optional;
  null loaders/tests keep working via static fallback.

## Next phase
Phase 2: built-in tools (read/edit/write/grep/find/ls/bash) served via
NativeToolMagnet through the same session HCP, replacing pi's direct tool
construction. NOTE: `copyRegistrations` copies `tool:` addresses, but package
tools currently register under `tool://<name>` (process/package-tool magnets) —
reconcile the address scheme when wiring built-in tools so all tools live in the
one session HCP under a consistent prefix.
