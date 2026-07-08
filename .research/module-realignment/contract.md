# Module Realignment (Model B) — Implementation Contract

**Status**: APPROVED for autonomous execution (user chose Model B, "重构就重构", not budget-limited)
**Model**: B — true per-module `ModuleHcpServer` (13), per-source `HcpMagnet`, single `HcpClient`
**Grounding**: All assertions traced to real code via 8 sub-agent investigations (agent_007-015)

---

## The Chain (user's locked model)

```
Agent Loop
   │  resolveCapability(name) / resolve(addr).instance(selector?)
   ▼
HcpClient  ── ONE per session (unchanged)
   ▼
HcpServer  ── ONE per Module (13 ModuleHcpServer instances)  ← THE CHANGE
   │  describe()/call()/instance(selector?) — dispatches to the right source
   ▼
HcpMagnet  ── ONE per source (pi/magenta/...) inside its module server
   ▼
Source 代码  (modules/<module>/<source>/*.ts)
```

---

## Grounded Facts (from investigation, not assumption)

1. **`instance()` widening is backward-compatible** (agent_012): NO call site anywhere passes a positional arg to `.instance()` today. Widening the contract to `instance<T>(selector?: string): T | undefined` breaks ZERO call sites — purely additive.

2. **Only 3 `instance()` authoring sites** (agent_013): `hcp-magnet/native.ts:128`, `hcp-magnet/universal.ts:125` (via `hcpInstance()` at :136, overridden at :199 CapabilityMagnet + :259 ResourceMagnet), `modules/multiagent/workflow/magenta/orchestrator.ts:394`. Everything else inherits `UniversalMagnet`.

3. **Runtime multi-slot is the proven template** (agent_009, agent_014): `runtimeMagentaMagnet` is ONE source magnet producing TWO addressable slots (`capability:runtime:process`, `capability:runtime:script-runtimes`) via `context.name` dispatch. This proves "one module owner → N addressable slots" already works — we generalize it.

4. **10 hardcoded consumer addresses MUST stay resolvable** (agent_008):
   - `resolveCapability`: `"compaction"`, `"policy"`, `"sandbox"`, `"runtime:process"`, `"hook"`
   - `resolve("tool:"+name).instance()`: `read, bash, edit, write, grep, find, ls`
   These are the refactor's external contract.

5. **Only 1 test breaks** (agent_015): `magnet-process.test.ts:174-177` asserts exact address ORDER. Fixable via `arrayContaining` or sort. All other `.instance()` tests are zero-arg (compatible).

6. **13 module folders, mixed shapes** (agent_007):
   - 10 capability modules (compaction/context/hooks/memory/multiagent/policy/prompt-templates/runtime/sandbox/system-prompt), each 1 `CapabilitySourceMagnet`
   - `tools` module: 7 built-in `NativeToolMagnet` (read/bash/edit/write/grep/find/ls) + more (todo/show/ssh/lsp/web-*)
   - `skills`, `tools-search`: no magnet today (out of scope — remain non-HCP)
   - runtime = 2 slots; policy/sandbox providers internally fan to sub-targets (approval://, shell://) but register ONE capability magnet each

---

## Design: ModuleHcpServer + per-address facades

The design that satisfies "13 real module servers" AND "17 stable addresses":

### Core primitive: `ModuleHcpServer` (NEW, `hcp-magnet/module-server.ts`)

```typescript
export class ModuleHcpServer {
  constructor(
    readonly moduleName: string,              // "tools", "compaction", "runtime"
    private readonly slots: Map<string, HcpMagnet>,  // selector → magnet
                                              // tools: "read"→readMagnet, "bash"→bashMagnet
                                              // compaction: "compaction"→compactionMagnet
                                              // runtime: "process"→..., "script-runtimes"→...
  ) {}

  /** All addresses this module owns (for registration + describeAll). */
  addresses(): string[] { /* ["tool:read", ...] or ["capability:compaction"] */ }

  /** The HcpServer facade for one address — what gets registered. */
  facadeFor(address: string, selector: string): HcpServer {
    return {
      describe: () => ({ ...this.slots.get(selector)!.toHcpServer!().describe(),
                         metadata: { module: this.moduleName, selector } }),
      call: (req) => this.slots.get(selector)!.toHcpServer!().call(req),
      instance: <T>() => this.slots.get(selector)!.toHcpServer!().instance!<T>(),
    };
  }
}
```

**Why facades**: `resolve()` prefers byExact (hcp-client.ts:42). Keeping 17 byExact facades means `resolve("tool:read").instance()` works UNCHANGED (facade knows its selector, calls the right magnet's instance). The 13 ModuleHcpServer instances are the real owning entities; facades are thin per-address views onto them.

**Why this is Model B, not a cosmetic layer**: The `ModuleHcpServer` is a real runtime object that OWNS its magnets and routes by selector. `describeModules()` returns the 13 servers directly. The facades exist only to preserve the flat-address resolution API that 10 consumers hardcode — they delegate to the module server, they don't duplicate logic. This is the same pattern runtime already uses (2 addresses, 1 owning source).

### `instance(selector?)` widening (enables direct module-server resolution)

Widen `HcpServer.instance<T>(selector?: string)` so a future consumer CAN call `resolve("tool").instance("read")` directly on a module server (not just via facade). This is the "clean" Model-B API; facades are the compat bridge. Both coexist.

---

## Invariants (verified each phase)

- **INV-B1 (address stability)**: All 10 consumer addresses resolve to the same-typed instance as before. Test: smoke assertion iterating all 10.
- **INV-B2 (one client)**: Still exactly one HcpClient per session.
- **INV-B3 (module servers real)**: `hcp.describeModules()` returns 13 entries, each a `ModuleHcpServer` owning its magnets (not a derived grouping of flat servers).
- **INV-B4 (test parity)**: harness 353→353+ (only magnet-process order test updated), pi 1636→1636.
- **INV-B5 (hot path off HCP)**: tool.execute() / provider methods still direct-called; `instance()` resolution is setup-time only.
- **INV-B6 (byte-identical external behavior)**: tool schemas, descriptions, renderKind, compaction/hook/policy behavior unchanged.

---

## Completion Assertions (PASS/FAIL each)

### C-B0: ModuleHcpServer primitive + widened instance()
- C-B0.1: `hcp-contract/hcp-server.ts` — `instance?<T>(selector?: string): T | undefined` (widened, optional).
- C-B0.2: 3 authoring sites updated (native.ts, universal.ts hcpInstance, orchestrator.ts) — accept+ignore/forward selector.
- C-B0.3: NEW `ModuleHcpServer` class with `addresses()`, `facadeFor()`, `describe()`, unit tests (single-slot, multi-slot, tool routing).
- C-B0.4: harness tsc clean + 353 tests green (only magnet-process order test may need `arrayContaining`).

### C-B1: tools module server (7 built-in tools → 1 ModuleHcpServer, 7 facades)
- C-B1.1: `buildBuiltInToolMagnets` result wrapped in `ModuleHcpServer("tools", {read→,bash→,...})`.
- C-B1.2: 7 `tool:<name>` facades registered (byExact), each resolves to correct AgentTool.
- C-B1.3: pi `resolve("tool:read").instance()` returns read tool (unchanged) — INV-B1.
- C-B1.4: pi 1636 green.

### C-B2: capability module servers (10 capabilities → 10 ModuleHcpServers)
- C-B2.1: each single-slot capability wrapped in `ModuleHcpServer(name, {name→magnet})`.
- C-B2.2: runtime wrapped as `ModuleHcpServer("runtime", {process→, script-runtimes→})` — 2 facades.
- C-B2.3: all 5 capability consumer addresses resolve (compaction/policy/sandbox/runtime:process/hook).
- C-B2.4: harness 353 + pi 1636 green.

### C-B3: describeModules() + registry alignment
- C-B3.1: `HcpClient.describeModules()` returns 13 module entries.
- C-B3.2: registry `buildHarnessModuleDescriptors` groups by module folder (id = folder name).
- C-B3.3: harness tests green.

### C-B4: menu shows 13 modules
- C-B4.1: `/dock` Harness menu top-level = "Modules" with 13 children from describeModules().
- C-B4.2: each module node shows sources + addresses; tools expands to 7 tools.
- C-B4.3: Registry/Catalog/LiveHCP unified under HCP-narrative submenu (not siblings of Modules).
- C-B4.4: pi green.

### C-B5: cleanup
- C-B5.1: no dead flat-registration code paths.
- C-B5.2: `agent-harness.ts` packagesRoot already fixed (prior work); verify.
- C-B5.3: full harness + pi green; tsc clean both.

---

## Phases (autonomous, each gated on green tests)

- **P0**: widen `instance(selector?)` contract + 3 authoring sites + `ModuleHcpServer` class + unit tests. Verify harness 353 green. (No consumer change yet.)
- **P1**: route `tools` through one `ModuleHcpServer` + 7 facades in `buildSessionHcp`. Verify pi 1636 green (tool resolution unchanged).
- **P2**: route 10 capabilities through `ModuleHcpServer` (incl. runtime 2-slot). Verify harness+pi green.
- **P3**: `describeModules()` + registry folder-grouping. Verify harness green.
- **P4**: menu → 13-module tree, unify Registry/Catalog/LiveHCP under HCP narrative. Verify pi green.
- **P5**: cleanup + full-suite + tsc both packages.

Each phase: rebuild harness dist before pi tests (known gotcha). Fix magnet-process order test in P0/P2 when address ordering shifts.

---

## Risks

- **R-B1 (facade proliferation)**: 17 facades + 13 module servers = 30 objects. Mitigation: facades are ~5-line delegators; module server holds the logic. Acceptable.
- **R-B2 (describe metadata)**: facades must carry `metadata.module` for menu grouping. Mitigation: set in facadeFor().
- **R-B3 (package overlay)**: overlay tools/capabilities must also flow through module servers or coexist. Mitigation: overlay servers keep current registration; describeModules() groups by metadata.module ?? parsed-address. Verify with a package loaded.
- **R-B4 (duplicate policy)**: register-servers duplicate detection compares exact target. Facades have distinct addresses — no new collisions.

---

## Success = all of:
harness 353 green · pi 1636 green · tsc clean both · 10 consumer addresses resolve · describeModules()=13 · menu shows 13 modules · ModuleHcpServer owns magnets (real Model B, not grouping facade).
