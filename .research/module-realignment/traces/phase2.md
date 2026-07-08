# Phase 2 Progress

**Goal**: Route 10 capabilities through ModuleHcpServers (incl. runtime 2-slot)
**Status**: COMPLETE ✅

## Changes
1. `hcp-contract/hcp-magnet.ts`: added `module: string` to `CapabilitySourceMagnet` (orthogonal axis)
2. All 10 source magnets: added `module:` field (hook→"hooks", prompt-template→"prompt-templates", rest match kind)
3. `hcp-client/assembly/capability.ts`:
   - added `modulesByKind()` + `moduleForKind()` derived from source magnets
   - rewrote `buildDefaultCapabilityHcp` to group magnets by module → `registerModule(new ModuleHcpServer(module, slots))`
   - runtime's 2 slots (process, script-runtimes) group into ONE ModuleHcpServer("runtime")
   - removed flat `registerMagnetHcpServers` call

## Key insight
- selector within a capability module = `capabilitySlotName(kind, name)`:
  - single-slot: "compaction", "context", "hook", ... (= kind)
  - runtime: "runtime:process", "runtime:script-runtimes"
- facade address = `capability:<selector>` (unchanged external contract)
- `resolveCapability("runtime:process")` → resolve("capability:runtime:process") → facade (selector="runtime:process") → magnet.instance() ✓

## Verification
- harness build clean ✅
- harness 363/363 green ✅ (360 baseline + 3 new module-grouping assertions)
  - capability-source-relocation extended with module-grouping regression tests
  - validates `moduleForKind` maps hook→hooks, prompt-template→prompt-templates
  - validates 10 source magnets → 10 modules (runtime's 2 slots = 1 module)
  - validates runtime module owns both slots, both facades resolve distinct instances
- pi bounded (--maxWorkers=4): 1636/1636 green ✅
- earlier default-parallelism failures CONFIRMED flaky (different files each run,
  all pass in isolation, only fail under >5x slowdown from resource contention)
