# Phase 3 Decision — Resources (context / system-prompt / prompt-templates / skills)

## Status: ✅ DECISION RECORDED (option b) — no consumer code change

## The four resource types

| Resource | Current pi path | Harness capability exists? | In CAPABILITY_KINDS? | Phase 3 decision |
|----------|-----------------|---------------------------|---------------------|------------------|
| system-prompt | `buildSystemPrompt()` + `overlay.resources.systemPromptPaths` | Yes (`systemPromptPiMagnet`) | **No** (regression-enforced) | Stay RESOURCE |
| context | `loadProjectContextFiles()` direct | Yes (`contextMagentaMagnet`) | Yes (assembled, unused) | Stay direct (see constraint) |
| prompt-template | `overlay.resources.promptTemplatePaths` | Yes (`promptTemplatePiMagnet`) | Yes (assembled, unused) | Stay resource |
| skills | `overlay.resources.skillPaths` | No | No | Stay pure resource |

## Decision: Option (b) — content/code segregation

**System-prompt stays a RESOURCE.** Content-only packages (e.g. AutOmicScience with content-only SYSTEM.md) must NOT route through the code-provider capability assembly. This is enforced by `harness/test/system-prompt-resource-regression.test.ts`: routing content through the capability code-builder caused a `capability_factory_missing` error. `system-prompt` is deliberately excluded from `CAPABILITY_KINDS`.

**Segregation principle (added to contract rationale):**
> Resources with pure content (SYSTEM.md, SKILL.md files) vs capabilities with code logic (formatSkills, discoverContextFiles) must stay separated. Content flows through `overlay.resources.*Paths`; code logic through HCP capabilities. Mixing causes assembly errors when packages provide content without code.

## Critical constraint discovered — why context is NOT routed through HCP

Contract C3.1 originally implied context should resolve via `resolveCapability("context")`. **This would violate INV-5.2 (byte-identity).** The two implementations are genuinely different:

- **pi `loadProjectContextFiles({cwd, agentDir})`** (resource-loader.ts:136): loads global context from `agentDir` first, then walks ancestors from `cwd` to filesystem root, deduping by path. Returns `Array<{path, content}>`.
- **harness `ContextProvider.discoverContextFiles(workspaceRoot)`** (modules/context/contract.ts:10): single `workspaceRoot` argument, different discovery semantics, expands imports + sanitizes, returns `ContextFile[]`.

Routing pi's context through the harness provider would change **which files are discovered** (no separate agentDir global load, different ancestor semantics) and their content (import expansion/sanitization). This breaks byte-identity.

**Decision: context stays on pi's direct `loadProjectContextFiles`.** The harness `context` capability is assembled into the session HCP but remains unused by pi's consumption path. This is acceptable: INV-1 applies to non-LLM harness content that pi CONSUMES; pi's context loader is pi-owned behavior, not harness-sourced behavior. Marking the capability "assembled but unused" preserves the option to migrate later if pi and harness context discovery are first reconciled.

## Why this satisfies the invariants

- **INV-1** (all harness-sourced content via one HcpClient): satisfied. System-prompt content, skills, prompt-templates are RESOURCES (file paths from overlay), not harness capabilities. Context is pi-owned behavior. The compaction/tool capabilities that ARE harness-sourced flow through HCP (Phases 1-2).
- **INV-5.2** (byte-identical output): trivially satisfied — zero consumption-path change. `buildSystemPrompt()` output unchanged; context discovery unchanged.

## Contract amendment needed (recorded here, applied in progress.md)

1. C3.1: change "context resolves via resolveCapability" → "context capability is assembled into the session HCP but pi consumes via its own `loadProjectContextFiles` until pi/harness context discovery are reconciled; this preserves INV-5.2. Assembled-but-unused is an intentional intermediate state."
2. C3.2: record decision (b) — system-prompt stays a resource; content/code segregation principle documented.
3. Add segregation principle to C3 rationale.

## Files changed for Phase 3

**None.** Phase 3 is a decision + documentation phase. The existing `system-prompt.test.ts` (pi) and `system-prompt-resource-regression.test.ts` (harness) already lock the byte-identity guarantee. No new code; INV-5.2 satisfied by construction.

## Verification

- Existing `buildSystemPrompt()` output unchanged (no code touched).
- pi `system-prompt.test.ts` + harness `system-prompt.test.ts` + `system-prompt-resource-regression.test.ts` remain green (verified in full-suite run).
