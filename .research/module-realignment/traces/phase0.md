# Phase 0 Progress

**Goal**: Widen `instance(selector?)` + implement `ModuleHcpServer` + update 3 authoring sites
**Status**: COMPLETE ✅

## Changes
1. `hcp-contract/hcp-server.ts`: widen `instance<T>(selector?: string)`
2. `hcp-magnet/module-server.ts`: NEW — ModuleHcpServer class
3. `hcp-magnet/native.ts`: thread selector through instance()
4. `hcp-magnet/universal.ts`: thread selector through hcpInstance()
5. `modules/multiagent/workflow/magenta/orchestrator.ts`: accept selector param
6. Test: `test/module-server.test.ts` (single-slot, multi-slot, tools routing)

## Verification
- harness tsc clean ✅ (after fixing erasableSyntaxOnly: no constructor param properties)
- harness 360/360 green ✅ (353 original + 7 new module-server tests)
- magnet-process order test did NOT break (registration untouched this phase)
- NO consumer changes (widening is additive) ✅
