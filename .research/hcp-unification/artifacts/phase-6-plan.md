# Phase 6 Plan — /dock menu as HCP view + Runtime A cleanup (C6)

Status: PLAN (research-only; no source touched). Author: peer session 019f40c5.
Cross-checked against code on 2026-07-08. Companion to `contract.md` C6 / INV-6.

## Objective (from contract C6)

- C6.1: `/dock` Harness menu is a **view over the single session HcpClient**
  (`describeAll()`); switches map to HCP enable/disable ops.
- C6.2: Registry/Catalog inspection views separated from live module toggles.
- C6.3: Runtime A (`agent-harness.ts`) deleted or demoted; duplicate tool
  wrapper logic removed; build + tests green.

## Verified ground truth (read from code, not assumed)

**Menu (C6.1/C6.2) — `pi/coding-agent/src/modes/interactive/interactive-mode.ts`:**
- `harnessMenuItems()` (L5149) builds the Harness subtree from
  `createHarnessRuntimeSnapshot()` (L5151).
- `createHarnessRuntimeSnapshot()` (L4503) reads `session.getAllTools()`,
  active tool names, settings, skills/package tools, AND
  `loadHarnessRegistryView()` (L4504) → which loads `registry.json` from disk —
  a **separate inventory from the HCP**.
- `handleHarnessMenuItem()` (L5544) dispatches `harness:*` values →
  `setActiveToolsByName`, auto-compact, skill commands, package selectors.
  Module/impl/catalog rows are inspect-only ("No runtime switch performed",
  ~L5576+).
- Session HCP is reachable: `AgentSession` exposes `get resourceLoader()`
  (L1651) and `ResourceLoader.getSessionHcp()` (interface `resource-loader.ts:72`,
  impl L519). So interactive-mode can call
  `this.session.resourceLoader.getSessionHcp()?.describeAll()`.
  `HcpClient.describeAll()` returns `HcpServerDescription[]` keyed by address
  (`tool:*`, `capability:*`).
- NOTE: no dedicated `AgentSession.getSessionHcp()` public passthrough exists
  (only used internally at L486/L2716). Reaching via `.resourceLoader.getSessionHcp()`
  works; optionally add a thin `AgentSession.getSessionHcp()` for symmetry.

**Runtime A (C6.3) — `harness/core/loop/pi/agent-harness.ts`:**
- `AgentHarness` uses `buildDefaultCapabilityHcp({ repoRoot: cwd,
  packagesRoot: cwd })` (L195) — the known `packagesRoot: cwd` bug.
- `new AgentHarness(` has **0 in-repo instantiations** outside tests (grep).
  Referenced only by 4 test files: `agent-harness.test.ts`,
  `compaction-injection.test.ts`, `agent-harness-stream.test.ts`,
  `tool-search.test.ts`. Exported publicly (`harness/index.ts`, `types.ts`).
- `packagesRoot: cwd` appears repo-wide only at `agent-harness.ts:195` (+ a
  comment in `session-hcp.ts:90` describing the divergence, and the built .d.ts).
- Its capability-fallback is already superseded by
  `session-hcp.ts:buildSessionHcp` (correct `packagesRoot = resolve(repoRoot,
  "packages")`).

**Duplicate tool logic (C6.3):** per `tool-duplication-analysis.md`, pi tool
files are wrappers that import `createXExecute`/schema from `@magenta/harness`
and add only render + options. C6.3's "duplicate logic removed" is a
**verification** step after C2, not a rewrite.

## Implementation steps

**C6.1 — Harness menu → HCP view**
1. (Optional) add `AgentSession.getSessionHcp(): HcpClient | undefined`
   passthrough to `resourceLoader.getSessionHcp()` for a clean call site.
2. Rewrite the tool/capability inventory inside `createHarnessRuntimeSnapshot()`
   to derive from `session…getSessionHcp()?.describeAll()` instead of
   `loadHarnessRegistryView()`. Map `tool:*` → Tools rows; `capability:*` →
   Compaction/Memory/Hook/Policy/Sandbox/Runtime/Context rows.
3. Keep switch handlers (`setHarnessToolEnabled` → `setActiveToolsByName`, etc.).
   Only the row *inventory* source changes; TUI text must match a golden menu
   snapshot.

**C6.2 — separate inspection from live toggles**
4. Group live HCP toggles (tool on/off, compact, skills, packages) under the
   primary Harness subtree; move `registry.json`/catalog/module inspect-only rows
   (`harnessModuleMenuItems`, `harnessCatalogMenuItems`, the "No runtime switch"
   branches ~L5576/5617) under a clearly-labeled **Inspect** node.

**C6.3 — Runtime A + cleanup**
5. **Recommended: demote + fix (lowest blast radius).** In `agent-harness.ts`
   fix L195 to `packagesRoot = resolve(repoRoot, "packages")` (route via
   `buildSessionHcp`/`buildDefaultCapabilityHcp`), add a header comment labeling
   `AgentHarness` a standalone SDK example (not pi's runtime). Keep the 4 tests.
   Alternative (delete): remove `index.ts` export, `types.ts:840`, 4 test files,
   update 3 docs — only if breaking the public SDK surface is acceptable.
6. Verify no re-implemented tool execute logic:
   `grep -nE "createBashExecute|createReadExecute|…" pi/coding-agent/src/core/tools/*.ts`
   should show only imports + render/options.
7. Confirm `packagesRoot: cwd` gone repo-wide (`grep -rn "packagesRoot: cwd"`).

## Files touched (expected)

- `pi/coding-agent/src/modes/interactive/interactive-mode.ts` — snapshot source
  swap (L4503+), Inspect grouping (L5149/5544 region). Largest change; TUI parity
  matters.
- (Optional) `pi/coding-agent/src/core/agent-session.ts` — `getSessionHcp()`
  passthrough.
- `harness/core/loop/pi/agent-harness.ts` — L195 packagesRoot fix + demote
  comment (demote path), OR deletion (delete path).
- Delete path only: `harness/index.ts`, `harness/types.ts:840`, 4 test files,
  `ARCHITECTURE.md` / `harness/README.md` / `core/loop/README.md`.

## Risk assessment

- **C6.1/C6.2 risk: MEDIUM.** interactive-mode is a large TUI file; snapshot
  rewrite risks menu-text drift and handler-value mismatches. Mitigate with a
  golden menu-tree snapshot test before/after; keep `handleHarnessMenuItem`
  value strings identical.
- **C6.3 risk: LOW (demote) / MEDIUM (delete).** Demote keeps tests + SDK
  surface; only fixes the bug and relabels. Delete removes a public export →
  breaks SDK consumers; needs doc + test churn. Recommend demote unless the team
  decides to drop the SDK example.
- Duplicate-logic step is pure verification — no risk.

## Verification

- C6.1: golden snapshot of the Harness menu tree (Tools + capability rows) built
  from `describeAll()` matches the intended inventory; toggles still call the
  same session ops.
- C6.2: Inspect node contains only inspect-only rows; live toggles are outside it.
- C6.3: `grep "packagesRoot: cwd"` → 0 code hits; tool files show imports only;
  `bun run build` (pi + harness) + both suites green (baseline pi 1631 / harness
  353); if delete path, doc references removed.
- INV-6: after Phase 6, one assembly path; Runtime A deleted or clearly-labeled
  SDK example with the packagesRoot bug removed.
