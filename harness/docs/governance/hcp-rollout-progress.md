# HCP Architecture Rollout — Execution Tracker

Authoritative spec: `hcp-architecture.md` (this dir). This file is the live
plan/observe/reflect state for delivering that spec across Magenta3. It is
disk-of-record — the multi-agent loop (Planner / Executor / Verificator) reads
and updates it rather than relying on conversation memory.

Branch: `feat/hcp-architecture-rollout` (off checkpoint `checkpoint/pre-hcp-rollout`).

## Verification gate (every step must pass before the next starts)

1. `cd harness && npm run build` — green.
2. `cd harness && npm test` — no regression vs the **229-test** baseline.
3. `cd harness && npm run check:structure` — green.
4. `npm --prefix pi/coding-agent run build` — green (when a step touches pi).

If a step fails twice, STOP and diagnose root cause; do not keep patching.

## Baseline confirmed (2026-07-03)

- `harness build` ✅; `harness test` = **27 files / 229 tests, all green**.
- The doc's premise "229 baseline incl. 1 failing AutOmicScience test" is
  STALE: there is no failing test. See Step C.
- `CAPABILITY_KINDS` (package-overlay.ts) already EXCLUDES `system-prompt`;
  it routes through the resource path (`case "system-prompt"`). §5.1 regression
  appears already fixed — Step C only needs a lock-in test.
- New role names (`HcpClient`/`HcpServer`/`HcpMagnet`) occur ONLY in the two
  governance docs; zero code collisions.
- Stray compiled artifacts (`harness/hcp/hcp/hcp.js|.d.ts|.map`) removed;
  `.gitignore` now blocks `harness/**/*.{js,d.ts,...}` outside dist.

## Occurrence counts (harness + pi; .ts/.toml/.md) — for §7

| Old identifier | matches | files |
|---|---|---|
| `HcpRegistry` | 67 | 20 |
| `HcpTarget` | 73 | 24 |
| `HcpTargetDescription` | 33 | 16 |
| `HcpCall` | 39 | 18 |
| `toHcpTarget` | 55 | 29 |
| `Magnet` (broad) | 141 | 33 |

## Steps

Status legend: TODO / IN-PROGRESS / VERIFYING / DONE / BLOCKED.

### Step A — §7 Naming migration  [DONE — commit 81c4506]
Mechanical rename, isolated commit, ZERO behavior change.
- `HcpRegistry` → `HcpClient` · `HcpTarget` → `HcpServer` · `HcpTargetDescription`
  → `HcpServerDescription` · `HcpCall` → `HcpRequest` · `Magnet`/`toHcpTarget()`
  → `HcpMagnet`/`toHcpServer()`. Added `HcpResponse<T>` alias (hcp.ts:55).
- 45 files (harness+pi). Wire addresses (`hcp:registry`, `capability:*`),
  `capabilityPrefix` value, and `magnet/` file paths deliberately unchanged.
- Verified by independent sub-agent: no residual old names, no corrupted
  compounds, build + 229 tests + pi build all green.
- FOLLOW-UP (separate scope, later): file `hcp-registry.ts` and internal wire
  address `hcp:registry` still use old vocab; revisit only in a dedicated
  behavioral change since `hcp:registry` is an address, not a type.

### Step B — §5 Resource primitive  [DONE — commit 992681a]
Added `HcpResource` binding + `ResourceMergeMode` (replace/append) to magnet.ts,
`toResource?()` on the `HcpMagnet` interface, and a `ResourceMagnet` class in
universal.ts (mirrors CapabilityMagnet; no toTool/toCapability). Extended the
one-of invariant in package-overlay.ts to tool XOR capability XOR resource.
+5 tests (resource-magnet.test.ts). Existing path-based resource flow
(PackageOverlayResources) left intact — this is the taxonomy addition.

### Step C — §5.1 Lock in the system-prompt-as-Resource fix  [DONE — commit 087a074]
Confirmed regression already closed: `system-prompt` is NOT in `CAPABILITY_KINDS`
(overlay routes it to `resources.systemPromptPaths`; existing overlay test shows
empty diagnostics). Added `system-prompt-resource-regression.test.ts` guard
(+2 tests, 236 total) asserting system-prompt/append-system-prompt are never
classified as capabilities. The pi `SystemPromptProvider` remains a legitimate
Capability (`system-prompt:pi` builder) — the two faces coexist per §5.

### Step D — §8 Magnet relocation  [DONE — barrel approach]
Dissolved `BUILTIN_CAPABILITY_BUILDERS` / `DEFAULT_CAPABILITY_SOURCES` central
literals in `hcp/magnet/capability.ts`. Each source now owns
`<module>/<source>/magnet.ts` (literal sibling import of its provider, survives
the build extension rewrite) exporting a `CapabilitySourceMagnet` descriptor
`{ kind, name?, source, isDefault?, defaultSlotNames?, build() }`. A dumb
aggregation barrel `hcp/magnet/sources.ts` statically re-exports the 9
source magnets with ZERO selection logic; `capability.ts` DERIVES the builder
table + default-source map from it (`buildersFromSourceMagnets` /
`defaultsFromSourceMagnets`). New `hcp/magnet/source-magnet.ts` holds the
descriptor type.

**User decision (confirmed):** barrel is an acceptable reading of "no central
builder map" — the invariant §10.1 protects is "no second SELECTION registry",
and a dumb collection makes no selection decisions. The alternative (runtime
computed imports) was rejected: it would pass tests + dist but break the bun
single-file binary (project ships one; see `skills.ts` `$bunfs` detection).

**User decision (confirmed):** barrel must live INSIDE the harness package —
placing it outside (sibling / top-level `.harness`) is impossible under the build
(`rootDir: .` forbids importing package-external source; dist ships only
`harness/dist`, so an external barrel would not be packaged and would crash at
runtime). Landed at `harness/hcp/magnet/sources.ts`.

Runtime-verified from BUILT dist: all 10 capability slots resolve with 0
diagnostics (incl. runtime's two slots via `defaultSlotNames`). +3 lock-in tests
(`capability-source-relocation.test.ts`); the existing per-capability suite now
exercises the relocated magnets end-to-end. 239 tests, structure check, pi build
all green. `system-prompt` stays OUT of `CAPABILITY_KINDS` (§5.1) — unchanged.

### Step E — §9 hotSwappable + §6 Tool Search  [DONE]

**§9 hotSwappable (commit 66a28a8):** added optional per-node
`hotSwappable: boolean` to `CapabilitySourceMagnet` + the capability component;
derived into the magnet's `describe()` metadata (`hotSwappable` key) via a
`HOTSWAPPABLE_CAPABILITY_SOURCES` map keyed by `kind:source`, alongside the
existing builder/default derivations. Defaults to frozen (`false`) so stateful
capabilities are safe by omission; all 9 built-ins are stateful and stay frozen.
Distinct from `bundledWith`/`bundles` (the selection-graph EDGES in the package
overlay), per §9. +4 tests.

**§6 Tool Search:** self-contained module, now at TOP-LEVEL
`harness/tools-search/tool-search.ts` (moved out of the HCP layer per the decision
that Tool Search is a Harness capability in its own right — an aggregator above
the per-tool magnets — not assembly-time wiring). Registered in the structure
check (`allowedTopLevel` + `sourceModuleDirs`) with a README.
- `buildToolSearchManifest(magnets)` — extracts name+description from tool
  magnets' CHEAP `describe()` (never realizes a schema), skipping non-tool
  magnets.
- `createToolSearchTool({ manifest, onActivate, alwaysActive, name?, limit? })`
  — a normal `AgentTool` (`tool_search`) that ranks manifest entries by keyword
  (name match > description match; every token must match), supports explicit
  `activate: [...]`, a `preview` mode, and activates matches by calling back
  into `onActivate` (wired to `AgentHarness.setActiveTools`, always preserving
  the always-active set).

**Key feasibility finding (verified in code):** NO pi fork needed. The harness
already separates the full tool `Map` from the `activeTools` subset the model
sees; `prepareNextTurn` (`agent-harness.ts:466`) rebuilds turn state each turn
from `this.activeToolNames`, so a tool-call that calls `setActiveTools` takes
effect on the NEXT model turn. Only `activeTools` are serialized
(`createContext` → `tools: turnState.activeTools.slice()`), so deferral is purely
a function of which tools are active — not of tool-object construction.

**Opt-in / behavior-preserving:** nothing defers unless a consumer wires the
meta-tool in and seeds a reduced initial active set. Proven end-to-end through
the real `AgentHarness` + faux provider: turn 1 the model sees only
`tool_search`; it activates `calculate`; turn 2 the model sees
`[calculate, tool_search]`. +12 tests (incl. the e2e loop test). 255 tests,
structure, pi build all green.

**Open (deferred, not blocking):**
- Wiring Tool Search into the actual coding-agent assembly (choosing the
  always-active core set + seeding the deferred manifest) is a product/config
  decision left to the assembly entry point; the mechanism is complete/tested.
- **Harness Search / pluggable search strategy.** Research of Claude's tool
  search (platform docs, fetched via proxy) confirmed search strategy is NOT
  singular: Claude ships `regex` + `bm25` server-side variants plus a
  client-side custom hook (embeddings/semantic). MCP is the *transport*; the
  ranker is a *separate substitutable concern*. Our keyword ranker is the
  built-in default; a future `ToolSearchStrategy` seam lets BM25/regex/embedding
  plug in without touching the deferral mechanism or meta-tool contract. This
  generalizes to "Harness Search": the enumerate-now/materialize-on-demand
  pattern MCP applies to tools, HCP faces for every numerous, runtime-discovered
  implementation (tools yes; capabilities no — §6: few, model-invisible,
  resolved once at assembly).

## Log
- 2026-07-03: Grounding + baseline done. Checkpoint committed
  (`checkpoint/pre-hcp-rollout`). Working branch `feat/hcp-architecture-rollout`
  created. Plan recorded. Multi-agent loop (sub_agent) verified working after
  adding a `pi` PATH shim with auth injection.
- 2026-07-03: Step A DONE (commit 81c4506). Naming migration complete +
  independently verified. Next: Step B (Resource primitive).
- 2026-07-03: Step B DONE (992681a) + Step C DONE (087a074). Resource primitive
  added to taxonomy; §5.1 locked. 236 tests, pi build green. Next: Step D
  (Magnet relocation / dissolve central builder table — highest structural risk).
- 2026-07-03: Step D investigation surfaced a build constraint (literal-import
  extension rewrite vs computed dynamic imports). Recorded recommended
  barrel-based approach + pilot plan. Paused for user confirmation on the
  "is a dumb aggregation barrel an acceptable reading of 'no central builder
  map'" interpretation before executing the large refactor.
- 2026-07-04: Step D DONE. User confirmed barrel approach + inside-harness
  placement. Relocated all 9 capability sources to `<module>/<source>/magnet.ts`,
  added `source-magnet.ts` (descriptor type) + `sources.ts` (dumb barrel),
  derived builder/default tables in `capability.ts`. Runtime-verified from built
  dist (10/10 slots, 0 diagnostics). 239 tests + structure + pi build green.
  Next: Step E (§9 hotSwappable node attribute; §6 Tool Search).
- 2026-07-04: Step E DONE. §9 hotSwappable node attribute (commit 66a28a8) +
  §6 Tool Search. Tool Search built entirely in harness
  (later moved to top-level `tools-search/`) as an opt-in meta-tool — verified NO pi fork needed
  because `prepareNextTurn` rebuilds the active tool set each turn, so
  `setActiveTools` from a tool-call lands on the next turn. Proven e2e through
  AgentHarness + faux provider. 255 tests, structure, pi build green.
  Remaining: wire Tool Search into the coding-agent assembly entry point
  (always-active core set + deferred manifest) — a config decision; and work
  item #8 (re-align old #21–#29 tasks to this contract).
