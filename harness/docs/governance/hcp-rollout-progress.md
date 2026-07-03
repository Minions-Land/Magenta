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
- Stray compiled artifacts (`harness/assembly/hcp/hcp.js|.d.ts|.map`) removed;
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

### Step D — §8 Magnet relocation  [TODO]
Dissolve `BUILTIN_CAPABILITY_BUILDERS` / `DEFAULT_CAPABILITY_SOURCES` /
`CAPABILITY_KINDS` central tables in `assembly/magnet/capability.ts`. Each source
owns `<module>/<source>/magnet.ts`; package overlay discovers + constructs during
selection. Replace with per-module descriptors (kind, sources, default source,
primitive kind, node attributes).

### Step E — §9 hotSwappable + §6 Tool Search  [TODO]
Highest risk; new features.
- `hotSwappable: boolean` per slot (Tools/Skills yes; Memory etc. no).
- `bundledWith` already exists (Codex bundles) — align naming/semantics.
- Tool Search: MCP-style deferral (lazy schema loading), needs pi loop changes.

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
