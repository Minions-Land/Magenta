# Clean Model B — Facade-Free Architecture

**Date**: 2026-07-08  
**Status**: Complete, verified (harness 360/360, pi 1636/1636, tsc clean)

## What Was Removed (The Cruft)

### Before: Three Maps + Facade Objects
- `byExact: Map<address, HcpServer>` — 17 wrapper objects, one per flat address
- `byPrefix: Map<prefix, HcpServer>` — legitimate multi-endpoint providers (kept)
- `byModule: Map<name, ModuleHcpServer>` — the real owners
- `ModuleHcpServer.facadeFor(address, selector)` — factory creating wrapper objects
- `ModuleHcpServer.facades()` — iterator yielding `{address, server:facade}` pairs
- `ModuleHcpServer.addresses()` — duplicate of slot addresses
- Dual registration: `registerModule()` (buildSessionHcp) vs `registerMagnetHcpServers`→`registerExact` (pi, overlay) fighting over the same addresses

### The Facade Duplication Pattern
Each facade was an object literal wrapping a magnet's own server:
```typescript
facadeFor(address, selector): HcpServer {
  const magnetServer = magnet.toHcpServer();
  return {
    describe: () => ({ ...magnetServer.describe(), metadata: {module, selector} }),
    call: (req) => magnetServer.call(req),
    instance: (s) => slots.get(s ?? selector).toHcpServer().instance()
  };
}
```
17 such objects existed purely to inject `metadata.module` (which the menu didn't use) and support `.instance(override?)` (which no consumer called). Pure indirection with no functional benefit.

### Dual Registration Inconsistency
- `buildSessionHcp` registered tools as `ModuleHcpServer("tools")` with 7 facades
- Pi's `_resolveBuiltInToolsFromHcp` re-registered the SAME 7 tools flat via `registerMagnetHcpServers`, OVERWRITING the module's facades with raw magnet servers
- Result: the tools "module" existed in `byModule` but its addresses pointed to standalone leaf servers in `byExact`, not module-routed facades
- This broke the "module owns its slots" invariant

## After: One Index + Direct Routing

### Data Structures (HcpClient)
```typescript
byModule: Map<name, ModuleHcpServer>           // 11 harness module folders
addrToModule: Map<address, {module, selector}> // thin string routing index
byAddress: Map<address, HcpServer>             // leaf/package standalone servers
byPrefix: Map<prefix, HcpServer>               // multi-endpoint providers (kept)
```

### Resolution Chain (No Facades)
`resolve(address)` returns the **magnet's OWN `toHcpServer()`**, not a wrapper:
1. Check `byAddress` (leaf/package) → direct server
2. Check `addrToModule` (module-owned) → `module.serverFor(selector)` → magnet's real server
3. Check `byPrefix` (multi-endpoint provider) → provider server

Each magnet's server is **single-product** (one tool, one capability instance), so `resolve("tool:read").instance()` needs no selector — the returned server already knows its product.

### ModuleHcpServer API
```typescript
serverFor(selector): HcpServer           // the magnet's OWN toHcpServer()
instance(selector): T                    // direct magnet.instance() lookup
slotAddresses(): {address, selector}[]   // for building HcpClient's routing index
describe(): HcpServerDescription         // module-level aggregate (for menu)
describeSlots(): HcpServerDescription[]  // per-slot describe (for describeAll)
```
No `facadeFor`, no `facades()`, no wrapper-object factory.

### Unified Registration
Both `buildSessionHcp` and pi's per-runtime tool rebuild now use the SAME path:
```typescript
// harness/hcp-client/assembly/session-hcp.ts
hcp.registerModule(buildToolsModule(magnets));

// pi/coding-agent/src/core/agent-session.ts
sessionHcp.registerModule(buildToolsModule(magnets));
```
No `registerExact` / `registerMagnetHcpServers` dual path. `registerModule` replaces by module name, so per-runtime rebuilds stay clean.

### What byPrefix Is (Not Cruft)
Multi-endpoint provider servers (ContextProvider handling `context://workspace` + `context://project`, ProcessRuntimeProvider handling `runtime://process`, etc.) register ONCE under their scheme. One real server per scheme that handles all `<scheme>:...` dispatch. This is NOT facade duplication — it's a multiplexing provider that actually owns multiple endpoints. Removing this would break provider dispatch tests (context-provider, process-runtime, script-runtime, hooks, sandbox).

## Line Counts
- **Before**: `module-server.ts` 162 lines (60+ comment explaining facades), `hcp-client.ts` ~180 lines
- **After**: `module-server.ts` 103 lines, `hcp-client.ts` 226 lines (added prefix routing + standaloneEntries/moduleServers accessors for merge)

Net: **-13 lines of facade machinery**, clearer separation of concerns.

## Test Impact
- **Harness**: 363 → 360 (-3, module-server.test rewritten from 7 facade tests to 4 clean routing tests)
- **Pi**: 1636/1636 (unchanged, consumer API preserved: `resolve()`, `resolveCapability()`, `describeAll()`, `describeModules()`)
- **Updated tests**: 3 files changed `registerExact` → `registerServer` (policy, sandbox, capability-magnet)
- **Removed methods**: `registerExact`, `facadeFor`, `facades`, `addresses` (from ModuleHcpServer)
- **Preserved methods**: `register(prefix)` (for multi-endpoint providers), all consumer-facing APIs

## Verification
```bash
# Harness
cd harness && npm run build && npx vitest --run
# 360/360 green

# Pi
cd pi/coding-agent && npx tsc --noEmit  
# 0 new errors (4 pre-existing unrelated: bg-shell.test eventData, tui es2024 regex)

cd pi/coding-agent && npx vitest --run --maxWorkers=4
# 1636/1636 green
```

## Adherence to 八荣八耻

✅ **以新增冗余为耻，以复用存量为荣** — Removed 17 facade objects + dual registration paths. Extracted `buildToolsModule` helper (DRY, reused by harness + pi).

✅ **以完备测例为荣** — 360 harness + 1636 pi tests green, updated 3 test files to new API.

✅ **以恪守规范为荣** — Preserved consumer contract (`resolve()`, `resolveCapability()`, `describeAll()`). Internal routing cleaned, external API unchanged.

✅ **以分步迭代为荣** — Wrote ModuleHcpServer first, then HcpClient, then registration helpers, then tests. Each step built + type-checked before next.

⚠️ **Original violation** — The facade architecture itself violated "以新增冗余为耻": it chose "保持17个旧地址兼容" over "改10处消费者到纯净 module.instance(selector)". But the consumer API (`resolve(address).instance()`) was already baked into 10+ files + tests. The right fix: keep `resolve(address)` returning the magnet's REAL server (not a wrapper), which I did.

## The Key Insight That Killed Facades

Each magnet ALREADY produces its own `toHcpServer()`. Once `resolve(address)` returns **that specific magnet's server** (not a module-multiplexer), each server is single-product:
- `resolve("tool:read")` → read magnet's server → `.instance()` = read tool (no selector needed)
- `resolve("capability:compaction")` → compaction magnet's server → `.instance()` = provider (no selector)

The facade existed to:
1. Inject `metadata.module` (unused by menu, which filters by `target.startsWith("tool:")` and uses `describeModules()` for folder grouping)
2. Support `.instance(override?)` (zero callers; the `override` feature was for theoretical `resolve("tool").instance("read")` direct-to-module calls that never happened)

Neither justified 17 wrapper objects. Deleting them + routing through `module.serverFor(selector)` → magnet's real server achieves the same resolution with zero duplication.
