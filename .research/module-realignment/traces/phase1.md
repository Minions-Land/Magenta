# Phase 1 Progress

**Goal**: Route 7 built-in tools through ONE `ModuleHcpServer("tools")` with 7 facades
**Status**: COMPLETE ✅

## Changes
1. `hcp-client/hcp-client.ts`: added `byModule` map, `registerModule()`, `describeModules()`, `resolveModule()`
2. `hcp-magnet/module-server.ts`: added `facades()` iterator (yields {address, selector, server})
3. `hcp-client/assembly/session-hcp.ts`: wrap `buildBuiltInToolMagnets` result in `ModuleHcpServer`, register via `registerModule()` instead of flat `registerMagnetHcpServers`

## Architecture
- Built-in magnets (read/bash/edit/write/grep/find/ls) → ONE `ModuleHcpServer("tools", Map<selector, magnet>)`
- Module produces 7 facades: `{address: "tool:read", selector: "read", server: facade}`, etc.
- Each facade delegates to the module server's slot map
- `hcp.registerModule(toolsModule)` registers all 7 facades in `byExact` + tracks module in `byModule`
- Consumer `resolve("tool:read").instance()` hits the facade, which calls the right magnet (unchanged API)

## Verification
- harness 360/360 green ✅
- pi 1636/1636 green ✅ (tool resolution unchanged from consumer perspective)
- `hcp.modules()` now returns `["tools"]`
- `hcp.addresses()` still returns 7 tool addresses (or 6 if bash not configured)
- `hcp.describeModules()` returns module-level summary with slot metadata
