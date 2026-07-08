# Phase 0 Artifacts

## Files created
- `harness/hcp-client/assembly/session-hcp.ts` — unified assembler (226 lines)
- `harness/test/session-hcp.test.ts` — verification test (145 lines, 8 tests pass)

## Files modified
- `harness/hcp-magnet/native.ts` — added `instance()` to NativeToolMagnet's HcpServer (6 lines)
- `harness/index.ts` — exported `buildSessionHcp` (1 line)

## Completion assertions verified
- ✅ C0.1: `buildSessionHcp` exists and returns one HcpClient
- ✅ C0.2: all expected tools + capabilities resolvable:
  - 7 tools: `tool:{read,bash,edit,write,grep,find,ls}`
  - 11 capabilities: `capability:{compaction,context,hook,memory,multiagent,policy,prompt-template,sandbox,system-prompt,runtime:process,runtime:script-runtimes}`
- ✅ C0.3: zero consumer changes (no imports of session-hcp outside test yet)
- ✅ C0.4: packagesRoot defaults to `getHarnessPackagesRoot(repoRoot)` — aligns with overlay

## Test results
- harness: 43 test files, 353 tests pass
- tsc -p tsconfig.build.json --noEmit: exit 0

## Invariants verified
- INV-2: one HcpClient returned, no second registry introduced
- INV-4: magnet one-of enforced (each yields tool XOR capability)

## Key findings / corrections
1. **Bug fixed in harness**: `NativeToolMagnet.toHcpServer()` lacked `instance()`, so `assemblePackageToolMagnets` would silently skip native tools. Now fixed — `instance()` returns the AgentTool, making tool + capability resolution uniform.

2. **Critic finding #2/#6 correction**: `system-prompt` and `multiagent` ARE assembled by `buildDefaultCapabilityHcp` (they have magnets in CAPABILITY_SOURCE_MAGNETS). The critic conflated the overlay's `CAPABILITY_KINDS` (excludes them) with the capability assembler (includes them).

3. **runtime is multi-slot**: `capability:runtime:process` + `capability:runtime:script-runtimes` (no bare `capability:runtime`).

## Next phase
Phase 1: wire pi's `AgentSession` to resolve compaction from `resourceLoader.getPackageHcp().resolveCapability("compaction")` instead of the direct import `from "./compaction/index.ts"`.
