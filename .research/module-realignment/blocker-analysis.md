# Module Realignment — Adversarial Review Findings

**Verdict**: Original design (Model A: 13 per-module HcpServers) is **BLOCKED** by HCP contract constraints.

---

## Critical Blockers

### Blocker 1: `instance()` is parameterless (hcp-server.ts:65, native.ts:136)

```typescript
interface HcpServer {
  instance<T = unknown>(): T | undefined;  // NO parameters
}
```

A "tools module server" wrapping 7 tool magnets cannot route `instance()` calls to the correct tool — the method has no `(toolName: string)` argument. When pi calls `resolve("tool:read").instance<AgentTool>()`, the server doesn't know the caller wants "read" vs "bash".

**Why this kills Model A**: The tools module needs ONE server handling 7 tools. Without routing parameters, `instance()` can only return ONE thing. The contract doesn't support "which tool do you want?"

### Blocker 2: `resolve()` prefers byExact over byPrefix (hcp-client.ts:42-45)

```typescript
resolve(address: string): HcpServer | undefined {
  const exact = this.byExact.get(address);  // Check exact FIRST
  if (exact) return exact;
  const prefix = address.split(":", 1)[0];
  return this.byPrefix.get(prefix);         // Fallback to prefix
}
```

If both `byExact["tool:read"]` AND `byPrefix["tool"]` exist, exact wins. To make a `tool:` prefix server handle `tool:read`, I must **delete** the exact entry — but pi hardcoded 7 calls to `resolve("tool:read")`, `resolve("tool:bash")`, etc. Deleting them breaks pi.

**Why this kills Model A**: Can't consolidate tools into a prefix server without breaking the 7 hardcoded address strings.

### Blocker 3: `describeAll()` returns one entry per registered server (hcp-client.ts:74-81)

```typescript
describeAll(): HcpServerDescription[] {
  for (const [address, target] of this.byExact) {
    described.set(address, target.describe());
  }
  for (const [prefix, target] of this.byPrefix) {
    described.set(`${prefix}:*`, target.describe());  // Single wildcard entry
  }
  return [...described.values()];
}
```

Collapsing 7 tool servers into 1 prefix server yields **one** `{target: "tool:*"}` entry in `describeAll()`. The pi menu does:

```typescript
const tools = descriptions.filter(d => d.target.startsWith("tool:"));  // Expects 7
```

With a prefix server, `tools.length === 1` (the wildcard entry), not 7. Menu shows "1 tool" instead of listing bash/edit/read/...

**Why this kills Model A**: UI/menu depend on per-tool granularity in `describeAll()`. Consolidation hides individual tools.

### Blocker 4: Runtime is NOT a precedent for multi-magnet servers

Adversarial agent checked `modules/runtime/magenta/magnet.ts`. Runtime has **one source factory** that produces **two capability instances** (process + script-runtimes), which become **two separate `CapabilityMagnet` instances**, registered as **two separate HcpServers**:

```
capability:runtime:process         → CapabilityMagnet(process).toHcpServer()
capability:runtime:script-runtimes → CapabilityMagnet(script-runtimes).toHcpServer()
```

It's 1 source → 2 magnets → 2 servers, NOT 1 server wrapping 2 magnets. Runtime proves **multi-slot is already handled by multiple servers under a common prefix**, not by module-level consolidation.

### Blocker 5: RETRACTED (agent was wrong)

I verified directly: `modules/policy/magenta/magnet.ts` and sandbox are standard single-`build()` `CapabilitySourceMagnet`s (`kind: "policy", source: "magenta", isDefault: true, build: () => new PolicyProvider()`). They do NOT emit multiple servers. This blocker is void.

**Confirmed instead**: runtime magnet (`modules/runtime/magenta/magnet.ts`) is ONE source magnet with `name: "process"`, `defaultSlotNames: ["script-runtimes"]`, and a `build(context)` that dispatches on `context.name`. This produces TWO byExact registrations (`capability:runtime:process`, `capability:runtime:script-runtimes`) from one source. So a "module" already legitimately spans multiple addresses — but as separate servers, not one wrapping server.

---

## Why the Original Design Assumed It Would Work (My Mistake)

I saw:
- `byPrefix` in HcpClient (unused today) → assumed I could leverage it for `tool:*`
- Multi-slot runtime → assumed it was "one server, two magnets" when it's actually "one source, two servers"
- `toHcpServer()` on every magnet → assumed I could compose them into a wrapper

I missed:
- `instance()` has no routing parameter → can't select which tool/magnet
- `resolve()` exact-first precedence → can't shadow existing addresses with a prefix
- `describeAll()` one-entry-per-server → menu/UI depend on the flat 17-server granularity

---

## Feasible Alternatives

### Alternative A: Metadata Layer Only (NO granularity change)

**What**: Keep 17 HcpServers (current), but add a **derived "module" metadata view** on top.

**How**:
- `describeAll()` returns 17 entries (unchanged)
- Add `describeModules()` that **groups** the 17 by parsing `target` strings:
  - `tool:read`, `tool:bash`, ... → module "tools" (7 servers)
  - `capability:compaction` → module "compaction" (1 server)
  - `capability:runtime:process`, `capability:runtime:script-runtimes` → module "runtime" (2 servers)
- Registry `buildHarnessModuleDescriptors` parses component.path for `modules/<folder>/` → derives 13 module groups
- Menu shows "Modules (13)" tree, each node lists its servers (from `describeModules()`)

**Pros**:
- Zero risk: no HCP contract changes, no routing changes, no address changes
- Pi's 10 hardcoded strings untouched
- Menu gets the "13 modules" structure user wants
- harness 353 + pi 1636 stay green (no functional change)

**Cons**:
- "Module" remains a presentation-layer concept, not a runtime entity
- Still 17 servers registered; `HcpClient.addresses()` returns 17 (though `describeModules()` shows 13)
- Doesn't fully align with "HcpServer = Module" mental model (it's "HcpServer = component, grouped into modules for display")

**Verdict**: **This is Model C**. Safe, incremental, achieves menu/registry unification without touching HCP internals.

---

### Alternative B: Extend `HcpServer` contract to support routing parameters

**What**: Change `instance<T>(selector?: string): T | undefined` to allow `instance<AgentTool>("read")`.

**How**:
- Modify `hcp-contract/hcp-server.ts`: `instance<T>(selector?: string | object): T | undefined`
- Modify all 17 existing `toHcpServer()` implementations to accept+ignore the parameter (backward compat)
- Implement `ModuleHcpServer` class that holds `magnets: Map<string, HcpMagnet>` and routes:
  ```typescript
  instance<T>(selector?: string): T | undefined {
    const magnet = selector ? this.magnets.get(selector) : this.defaultMagnet;
    return magnet?.toHcpServer().instance<T>();
  }
  ```
- Update `resolveCapability()` / pi call sites to pass tool name: `resolve("tool").instance<AgentTool>("read")`

**Pros**:
- Achieves true per-module servers (13)
- `instance()` can route to specific magnets
- Clean "1 Client → 13 Servers → N Magnets" model

**Cons**:
- **Breaking change** to HCP contract (hcp-server.ts interface)
- Touches every magnet (17+ `toHcpServer()` implementations must add parameter)
- Breaks all pi call sites (10 places need `resolve("tool:read")` → `resolve("tool").instance("read")`)
- High risk: 300+ lines changed, 2+ weeks
- Harness 353 tests likely break (any that assert `instance()` signature)

**Verdict**: **Possible but very invasive**. Only worth it if you want "Module = HcpServer" at the contract level, not just presentation. Requires contract redesign approval.

---

### Alternative C: Hybrid (per-module for capabilities, flat for tools)

**What**: Consolidate the 11 single-source capabilities into module servers (via metadata wrapper), but **leave tools flat** (7 individual servers).

**How**:
- Tools: keep `tool:read`, `tool:bash`, ... as 7 byExact servers (no change)
- Capabilities: add `ModuleHcpServer` wrapper for single-source ones (compaction, hooks, policy, sandbox, ...), but still register at byExact addresses (`capability:compaction` → server that wraps compactionPiMagnet)
- The wrapper's `instance()` just delegates to its sole magnet (no routing needed)
- Menu groups tools under "tools module" (metadata), capabilities under their module folders (1 server = 1 module for capabilities)

**Pros**:
- Partial alignment: capabilities become per-module, tools stay flat
- No `instance()` routing problem (each capability server has 1 magnet)
- Pi call sites unchanged (all 10 addresses still byExact)
- Lower risk than full Model A

**Cons**:
- Asymmetric: tools != capabilities in registration model
- Still doesn't achieve "1 module = 1 server" universally
- Tools module is a special case (7 servers under a conceptual umbrella)

**Verdict**: **Compromise**. Gets most of the module alignment without breaking tools.

---

## Recommended Path Forward

Given the user's goal ("把 Registry/Catalog/LiveHCP 统一到 HcpClient/HcpServer/HcpMagnet 叙事"), I recommend:

**Phase 1-3: Alternative A (Metadata Layer, zero risk)**
- Implement `describeModules()` on HcpClient that groups the 17 servers by module folder
- Rewrite `buildHarnessModuleDescriptors` to parse component.path → derive 13 modules
- Rewrite menu to show "Modules (13)" tree using `describeModules()`
- Unify Registry/Catalog/LiveHCP into one "HCP Client" top-level with "Modules" + "Runtime Diagnostics" submenus
- **Outcome**: Menu/registry aligned with 13 folders; HCP internals unchanged; tests green

**Phase 4+ (optional): Alternative B if user insists on contract-level alignment**
- After Phase 1-3 proves the metadata model, revisit whether the contract redesign (adding routing parameters) is worth it
- Requires user to approve breaking changes to hcp-server.ts + all magnets + pi call sites

---

## What to Tell the User

"I've designed Model A (13 per-module HcpServers) but adversarial review found 3 contract blockers: `instance()` is parameterless (can't route to specific tools), `resolve()` prefers exact over prefix (can't shadow tool:read), and `describeAll()` returns one entry per server (menu expects 7 tool entries, not 1). 

The HCP contract as designed is optimized for **flat, per-component servers** (current 17). Consolidating to 13 per-module servers requires either (A) metadata-only grouping (safe, zero risk, menu gets 13 modules but HCP stays 17 servers internally), or (B) redesigning the HCP contract itself (add routing parameters to `instance()`, invasive, 300+ lines changed).

I recommend **Alternative A first** — it achieves your menu/叙事 unification goal with zero risk. If you later want true 'Module = HcpServer' at the contract level, we can do Alternative B as a second phase. But Alternative A alone might be enough."

Do you want me to:
1. Write the Alternative A (metadata-only) design and implement it?
2. Revise the original contract to be Alternative B (contract redesign) and get your approval before implementing?
3. Something else?
