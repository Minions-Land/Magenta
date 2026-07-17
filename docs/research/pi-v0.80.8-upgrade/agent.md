# packages/agent v0.80.2 -> v0.80.8 exhaustive upgrade analysis

## Scope and evidence model

- Upstream baseline: `U2=/tmp/magenta-pi-v0802`, target: `U8=/tmp/magenta-pi-v0808`.
- Authoritative Git history: `/tmp/magenta-pi-upstream-v0.80.8-20260717`, range `v0.80.2..v0.80.8`.
- Imported Magenta snapshot: `/tmp/magenta-import-f1da4c`. Its `pi/agent/src/{agent,agent-loop,types}.ts` are byte-identical to U2. The snapshot does not contain the top-level `harness/` directory created by Magenta commit `f1da4c9`; where harness evidence is required, this report verifies the same import point through `git show f1da4c9:harness/...` in the current repository.
- Current Magenta: `/Users/mjm/Magenta3` at `4a08f63`.
- Status vocabulary: `PRESENT`, `PARTIAL`, `SUPERSEDED`, `MISSING`, `CONFLICT`, `N/A`.
- Exhaustiveness boundary: all 12 non-empty official `packages/agent/CHANGELOG.md` bullets in versions 0.80.3 through 0.80.8, plus the explicitly requested cross-package contracts for `Usage.reasoning`, post-compaction usage, and `Models`/`ModelRuntime`. Empty 0.80.5 and 0.80.8 sections are recorded in the appendix but create no semantic AG item.

## Executive result

| Status | Count | IDs |
|---|---:|---|
| PRESENT | 3 | AG-002, AG-011, AG-014 |
| PARTIAL | 1 | AG-015 |
| CONFLICT | 1 | AG-006 |
| MISSING | 10 | AG-001, AG-003, AG-004, AG-005, AG-007, AG-008, AG-009, AG-010, AG-012, AG-013 |

Highest-risk gaps are AG-007 (length-truncated calls can execute, including Magenta-recovered literal tool calls), AG-012 (dynamic tool activation is not transcript-anchored), AG-006 (current HCP compaction deliberately runs split summaries concurrently), and AG-015 (Magenta still owns auth/model flow through the legacy registry plus a partial `Models` cast).

## Semantic inventory

### AG-001 - `Agent.prepareNextTurnWithContext`

- **Version / official text:** 0.80.3 Added: “Added `prepareNextTurnWithContext` for `Agent` users that need the next-turn loop context.”
- **SHA:** implementation/initial next-turn refresh `e547bb9f4180599629c45871c8311a51e1ec4f2f`; compatibility API and test `fd6659dd5d32d67feaa7ce2ba5eeb87c5705149c`.
- **Upstream files/symbols:** `packages/agent/src/agent.ts`: `AgentOptions.prepareNextTurnWithContext`, `Agent.prepareNextTurnWithContext`, constructor assignment, `createLoopConfig()` dispatch; `packages/agent/test/agent.test.ts` and `CHANGELOG.md`.
- **Contract/behavior:** stateful `Agent` users can receive `PrepareNextTurnContext` (`message`, `toolResults`, current context, new messages) and the active run abort signal. The old callback remains signal-only.
- **Import evidence:** `/tmp/magenta-import-f1da4c/pi/agent/src/agent.ts` has only `prepareNextTurn(signal?)`; no `prepareNextTurnWithContext`.
- **Current evidence:** `/Users/mjm/Magenta3/pi/agent/src/types.ts` still exposes low-level `AgentLoopConfig.prepareNextTurn(context)` and `/pi/agent/src/agent-loop.ts` invokes it, but `/pi/agent/src/agent.ts` exposes only the legacy signal callback and wraps it as `async () => this.prepareNextTurn(this.signal)`. There is no context-aware public wrapper API.
- **Status:** **MISSING**. Low-level context support is not equivalent to the public `Agent` API.
- **Migration action/dependencies:** add the separate option/property and select it first in `createLoopConfig`, preserving the legacy branch exactly. Incorporate Magenta's added `hasMoreToolCalls` field in `PrepareNextTurnContext`; do not copy U8's older context shape blindly.
- **Tests:** port the context callback test and assert current context/model/tool results plus `signal === agent.signal`; also retain the legacy signal test and a case where both callbacks are supplied (context-aware wins).

### AG-002 - legacy `Agent.prepareNextTurn` abort signal

- **Version / official text:** 0.80.3 Fixed: “Fixed `Agent.prepareNextTurn` to keep receiving the run abort signal instead of the next-turn context.”
- **SHA:** regression introduced/identified by `e547bb9f...`; final correction `fd6659dd5d32d67feaa7ce2ba5eeb87c5705149c`.
- **Upstream files/symbols:** `packages/agent/src/agent.ts:createLoopConfig`; `packages/agent/test/agent.test.ts` test “keeps legacy prepareNextTurn signal callback behavior”.
- **Contract/behavior:** the legacy callback's first argument remains the active `AbortSignal`; adding a context API must not silently repurpose it.
- **Import evidence:** U2/import already wrap the low-level callback and pass `this.signal`, so the final contract is present despite the transient upstream regression inside the range.
- **Current evidence:** `/Users/mjm/Magenta3/pi/agent/src/agent.ts:createLoopConfig()` still calls `this.prepareNextTurn?.(this.signal)`.
- **Status:** **PRESENT**.
- **Migration action/dependencies:** no behavior change; AG-001 must be implemented as a distinct callback to avoid regressing this item.
- **Tests:** current suite lacks U8's explicit legacy regression test; port it before AG-001.

### AG-003 - session context entry transforms and custom projectors

- **Version / official text:** 0.80.4 Added: “Added configurable harness session context entry transforms and custom-entry message projectors.”
- **SHA:** `dd1c690f36de449fac9b24c8b3d113837eaf7cfb`.
- **Upstream files/symbols:** `src/harness/session/session.ts`: `ContextEntryTransform`, `CustomEntryContextMessageProjector`, `SessionContextBuildOptions`, `defaultContextEntryTransform`, `buildContextEntries`, `sessionEntryToContextMessages`, `Session.buildContextEntries`, option merging; docs and `test/harness/session.test.ts`.
- **Contract/behavior:** derive runtime state from the full active branch, then run the default latest-compaction selection, then stacked custom transforms, then project entries. `custom` entries remain in the entry sequence but are omitted from model messages unless a keyed projector returns messages. Constructor options stack with per-call transforms; per-call projectors override same-name defaults.
- **Import evidence:** `git show f1da4c9:harness/session/session.ts` has monolithic `buildSessionContext()` and `Session(storage)` only.
- **Current evidence:** `/Users/mjm/Magenta3/HarnessComponentProtocol/_magenta/session/pi/session.ts` retains that monolithic U2 shape; searches find no `entryTransforms`, `entryProjectors`, or `buildContextEntries` in HCP.
- **Status:** **MISSING**.
- **Migration action/dependencies:** port into the HCP session implementation and public types/barrel, adapting `AgentMessage` imports to the current package boundary. Ensure HCP's component context system is not confused with session-entry projection; they solve different layers.
- **Tests:** port the three U8 cases: custom entry retained/omitted by default, keyed projector, transforms after default compaction. Add constructor+call stacking and projector override tests.

### AG-004 - custom JSONL session header metadata

- **Version / official text:** 0.80.4 Added: “Added custom metadata support in JSONL session headers (#6417).”
- **SHA:** `7198e78f99d50776cce5368efe958e616f35156d`.
- **Upstream files/symbols:** `jsonl-storage.ts:SessionHeader.metadata`, header validation, `headerToSessionMetadata`, `JsonlSessionStorage.create`; `jsonl-repo.ts:create/fork`; `harness/types.ts:JsonlSessionMetadata` and `JsonlSessionCreateOptions`; repo/storage tests.
- **Contract/behavior:** optional object metadata round-trips through create/open/one-line list loading/fork. Fork inherits source metadata unless explicitly overridden. Non-object/null/array metadata makes the session invalid; absent metadata is omitted from the header.
- **Import evidence:** `git show f1da4c9:harness/session/jsonl-storage.ts` has no header metadata or validation; import types lack metadata on JSONL metadata/create options.
- **Current evidence:** HCP `_magenta/session/pi/jsonl-storage.ts` and `_magenta/types/types.ts` still lack the field; create accepts only cwd/sessionId/parent path; `JsonlSessionMetadata` has no custom metadata. HCP tests cover ordinary header metadata only, not custom metadata.
- **Status:** **MISSING**.
- **Migration action/dependencies:** update HCP storage, repo, and type contracts together. Decide whether arbitrary metadata is allowed across the HCP public boundary; if yes, export it consistently and preserve unknown JSON values without mutation.
- **Tests:** port round-trip, omission, invalid type, list, inherited fork, and overridden fork tests. Include `readTextLines(maxLines:1)` coverage.

### AG-005 - root exports for storage implementations

- **Version / official text:** 0.80.4 Added: “Exported `InMemorySessionStorage` and `JsonlSessionStorage` (#6435).”
- **SHA:** `cb222bf99d209711b5546bf54931862f391418d0`.
- **Upstream files/symbols:** `packages/agent/src/index.ts` exports `./harness/session/{jsonl-storage,memory-storage}.ts`.
- **Contract/behavior:** consumers can instantiate concrete storage through the package root rather than a private internal path.
- **Import evidence:** Magenta import's top-level `harness/index.ts` exports repos/session but not either storage class.
- **Current evidence:** `HarnessComponentProtocol/index.ts` exports `repo-utils`, `session`, `uuid`, and types, but not `_magenta/session/pi/jsonl-storage.ts` or `memory-storage.ts`. Tests import those private paths directly.
- **Status:** **MISSING**.
- **Migration action/dependencies:** export both classes and `loadJsonlSessionMetadata` through `@magenta/harness` if the concrete storage API remains supported. AG-004 and AG-010 should land before declaring parity.
- **Tests:** add a package-root compile/runtime export test; do not rely only on private-path tests.

### AG-006 - serialize split-turn compaction summaries

- **Version / official text:** 0.80.4 Fixed: “Fixed harness split-turn compaction to serialize summary requests so single-concurrency providers are not asked to run overlapping generations (#5536).”
- **SHA:** `f58c11562605a21bcf3d3e45553c78fe105809f9`.
- **Upstream files/symbols:** `src/harness/compaction/compaction.ts:compact`; replaces `Promise.all([generateSummary, generateTurnPrefixSummary])` with awaited history then awaited turn prefix.
- **Contract/behavior:** at most one summary generation is active per split-turn compaction. History failure stops before starting prefix summarization.
- **Import evidence:** `git show f1da4c9:harness/compaction/compaction.ts` uses `Promise.all`.
- **Current evidence:** `/HarnessComponentProtocol/compaction/pi/compaction.ts:compact` again uses `Promise.all` for history and turn-prefix streams. Current code adds incremental chunking and aggregated progress but explicitly violates the upstream single-concurrency contract.
- **Status:** **CONFLICT**.
- **Migration action/dependencies:** serialize the two streams while retaining incremental summaries and progress. Initialize/report the second stream only when it starts; preserve total/progress monotonicity. This follows the W5/W6 Models/ModelRuntime adapter so summary calls use the canonical provider surface, and it must complete before W8 dynamic-tool replay/compaction integration.
- **Tests:** add an instrumented `Models.completeSimple` with `active/maxActive` assertions (`maxActive === 1`), history-failure short-circuit, abort between phases, and monotonic progress across both phases.

### AG-007 - reject tool calls from length-truncated assistant messages

- **Version / official text:** 0.80.4 Fixed: “Fixed harness tool calls from length-truncated assistant messages to fail instead of waiting for missing tool results (#6285).”
- **SHA:** `351efc828b6fc5250fa50d6b32b20b0f0cb22cb4`.
- **Upstream files/symbols:** `agent-loop.ts:failToolCallsFromTruncatedMessage`, branch in `runLoop`; `test/agent-loop.test.ts`.
- **Contract/behavior:** if `AssistantMessage.stopReason === "length"`, no tool call in that message executes, even if salvaged arguments parse and validate. Each emits start/end/error tool-result events so the transcript is complete and the model can reissue it.
- **Import evidence:** import `agent-loop.ts` always calls `executeToolCalls`.
- **Current evidence:** current `pi/agent/src/agent-loop.ts` still always executes. Magenta's `applyTextToolCallRecovery()` additionally recovers literal `<invoke>` calls for `stopReason === "length"`; those recovered calls are then executable, increasing the unsafe surface.
- **Status:** **MISSING**.
- **Migration action/dependencies:** run text recovery first if desired, but route every real or recovered length-truncated call to the failure path. Preserve Magenta event semantics and ensure no preflight/hook/tool invocation occurs.
- **Tests:** port U8's no-execute/event/transcript case and add a Magenta-specific literal `<invoke>` + length case. Cover multiple calls and sequential/parallel modes.

### AG-008 - normalize null message content at ingestion

- **Version / official text:** 0.80.4 Fixed: “Fixed harness session ingestion to normalize `null` message content before context projection, avoiding crashes on lax imported transcripts (#6343).”
- **SHA:** `8c0ccd14b34b6e5c403363518e331094b69ebf6c` (crosses ai/agent/coding-agent); official agent wording was added by changelog audit `bf75b8aa...`.
- **Upstream files/symbols:** agent `createToolResultMessage()` uses `finalized.result.content ?? []` and preserves the prior result with `...result` in the after-hook merge; ai `api/transform-messages.ts` normalizes message content before provider conversion.
- **Contract/behavior:** untyped tools/imported transcripts may contain null despite static types. Null must not enter persisted session/provider projection. After-tool hooks must not erase unrelated result fields.
- **Import evidence:** import agent directly uses `finalized.result.content`; import ai has no ingestion normalization.
- **Current evidence:** current agent still assigns content directly and reconstructs the after-hook result without `...result`; current ai lacks `normalizedMessages = messages.map(msg => msg.content == null ? ...)`.
- **Status:** **MISSING**.
- **Migration action/dependencies:** port both boundaries, not only agent. Preserve `...result` so AG-012 metadata survives hooks. Consider normalizing imported assistant/user/toolResult messages in HCP session projection too.
- **Tests:** null tool result, null imported message through every provider transform, after-hook preserving unknown/additional fields, and persistence round-trip.

### AG-009 - reject non-positive and oversized shell timeouts

- **Version / official text:** 0.80.4 Fixed: “Fixed non-positive or oversized harness shell execution timeouts to fail with a clear validation error instead of being clamped to an immediate timeout (#6181).”
- **SHA:** oversized `cbcf4e04c3f2e5822d9349fae9b7ba13a39bdefc`; non-positive/non-finite `85b7c24741096f147747689e21c4bc6892061824`.
- **Upstream files/symbols:** `harness/env/nodejs.ts`: `MAX_TIMEOUT_MS`, `MAX_TIMEOUT_SECONDS`, `resolveTimeoutMs`, early validation in `NodeExecutionEnv.exec`.
- **Contract/behavior:** undefined means no timeout; finite seconds must be `> 0` and no greater than Node's 2,147,483,647 ms timer limit. Invalid values return `ExecutionError("timeout", clear message)` before spawn.
- **Import evidence:** f1da harness checks only `typeof timeout === "number"` and multiplies directly.
- **Current evidence:** current HCP `_magenta/env/pi/nodejs.ts` retains the import behavior; no validation constants/helper. Tests cover an actually elapsed small timeout only.
- **Status:** **MISSING**.
- **Migration action/dependencies:** port validation into HCP environment. Also align the separate Magenta bash tool timeout schema so both public layers reject the same domain rather than disagreeing.
- **Tests:** `0`, negative, `NaN`, `Infinity`, `-Infinity`, `MAX+epsilon`, exact max, fractional positive, undefined; assert invalid cases never spawn.

### AG-010 - random-tail short session entry IDs

- **Version / official text:** 0.80.4 Fixed: “Fixed harness session storage short entry ids to use the random tail of the generated uuidv7 instead of the timestamp prefix, which was nearly constant between calls (#6242).”
- **SHA:** `1dac099022e764c0d400495597f688f7224ac2ee`.
- **Upstream files/symbols:** both `jsonl-storage.ts` and `memory-storage.ts`: `generateEntryId()` changes `uuidv7().slice(0, 8)` to `.slice(-8)` with collision retry.
- **Contract/behavior:** short IDs retain randomness for UUIDv7 calls made in the same time window; full UUID remains fallback after 100 collisions.
- **Import evidence:** f1da storage classes use `.slice(0, 8)`.
- **Current evidence:** both HCP storage classes still use `.slice(0, 8)`.
- **Status:** **MISSING**.
- **Migration action/dependencies:** change both implementations together; do not change existing persisted IDs or the UUID generator.
- **Tests:** deterministic/mocked UUID sequence proving tail selection and collision retry in both stores; high-volume uniqueness sanity check.

### AG-011 - `max` thinking level

- **Version / official text:** 0.80.6 Added: “Added the `max` model thinking level after `xhigh`.”
- **SHA:** `fbdd46389c3a0c03b62f5e9eabe31a85044ef8ce`.
- **Upstream files/symbols:** agent `src/types.ts:ThinkingLevel`, README/changelog; broader ai/provider/CLI/theme changes in the same commit.
- **Contract/behavior:** public reasoning union accepts opt-in `max`; support remains model-metadata-driven rather than universal.
- **Import evidence:** both import agent and ai unions end at `xhigh`.
- **Current evidence:** current `pi/agent/src/types.ts` and `pi/ai/src/types.ts` include `max`; CLI/theme/docs/tests also expose it. Agent blame points to local `0cef55a`; later `c97d255` hardens GPT-5.6 mapping.
- **Status:** **PRESENT** (independent Magenta implementation).
- **Migration action/dependencies:** no direct port. Keep upstream model metadata tests conceptually aligned; Magenta's `ultra` execution profile must remain a host profile and never leak as a provider ThinkingLevel.
- **Tests:** existing current args/model tests cover max/Ultra; retain provider clamp and theme fallback tests.

### AG-012 - message-anchored dynamic tools via `addedToolNames`

- **Version / official text:** 0.80.7 Added: “Added `AgentToolResult.addedToolNames` propagation to `ToolResultMessage` so tools introduced by a result can be loaded from that transcript point onward (#6474).”
- **SHA:** `3d8f74357c169d24f996a1611ecc4be72b7744bd`; official agent changelog entry added by `4c186103...`.
- **Upstream files/symbols:** agent `AgentToolResult.addedToolNames` and `createToolResultMessage`; ai `ToolResultMessage.addedToolNames`, deferred-tool utilities and Anthropic/OpenAI Responses serializers; coding-agent extension runner/wrapper/registry.
- **Contract/behavior:** tool definitions introduced during a run are annotated at the exact tool-result message where they became available. Deferred-capable providers serialize definitions from that anchor onward, preserving the earlier prompt-cache prefix. Other providers still use full `Context.tools` normally.
- **Import evidence:** no `addedToolNames` anywhere in imported agent/ai.
- **Current evidence:** current agent and ai have no marker. Magenta has dynamic registration/tool search, but that is registry/discovery behavior, not transcript anchoring. `HarnessComponentProtocol/tools/tool-search` documentation describes deferral at discovery level only. Current after-hook result reconstruction would also discard a newly added field unless AG-008's `...result` change lands.
- **Status:** **MISSING**.
- **Migration action/dependencies:** land AG-008 first; then add marker types and propagation, provider deferred serializers, extension/HCP activation plumbing, and session persistence. Decide how HCP tool search reports names activated by a tool result without moving activation earlier.
- **Tests:** port ai deferred-tools cases and coding-agent regression #6162; add agent-level propagation (upstream lacks a direct test), after-hook preservation, resume/replay anchor, compaction across anchors, Anthropic/OpenAI cache-prefix payload snapshots, and fallback-provider behavior.

### AG-013 - `Usage.reasoning` propagation (cross-package dependency)

- **Version / official text:** ai 0.80.3 Added: “Added an optional `reasoning` field to `Usage` reporting reasoning/thinking token counts as a subset of `output`. Populated for Anthropic (`output_tokens_details.thinking_tokens`), OpenAI Responses/Codex/Azure (`output_tokens_details.reasoning_tokens`), OpenAI Completions (`completion_tokens_details.reasoning_tokens`), and Google Generative AI / Vertex (`thoughtsTokenCount`). Bedrock Converse and Mistral are not populated because those APIs do not return a reasoning token breakdown (#6057).”
- **SHA:** `d7868b099853a68f4fdb94f05e6913760dde3f7e`.
- **Upstream files/symbols:** `packages/ai/src/types.ts:Usage.reasoning`; population in six provider paths. Agent consumes `AssistantMessage.usage` structurally; no direct package-agent source edit.
- **Contract/behavior:** reasoning is optional and already included in `output`; consumers must not add it again to context/cost totals. A provider with a breakdown sets a number, possibly zero; providers without one leave it undefined.
- **Import evidence:** import ai `Usage` has no field and provider parsers do not populate it.
- **Current evidence:** current ai `Usage` still has no field; current provider parser searches show no usage assignments. Magenta commit `fe45996` displays per-message usage stats, but it can only display existing total/cache fields and does not substitute for provider propagation.
- **Status:** **MISSING**.
- **Migration action/dependencies:** port type plus all provider parsers atomically; update any usage cloning/aggregation/serialization so optional reasoning is retained. HCP `calculateContextTokens` must continue using `totalTokens` or input/output/cache fields only.
- **Tests:** provider fixtures for nonzero/zero/undefined; proxy/session round-trip; per-message telemetry; explicit assertion that context/cost calculations do not double-count reasoning.

### AG-014 - ignore stale pre-compaction usage (cross-package dependency)

- **Version / official text:** ai 0.80.6 Fixed: “Fixed post-compaction output-token budgeting to ignore stale assistant usage from before the compaction boundary (#6464).”
- **SHA:** `8973ae28ab926c43d4088d837b19b8093359e54b` (`packages/ai/src/utils/estimate.ts` and context-estimate tests).
- **Upstream files/symbols:** `packages/ai/src/utils/estimate.ts:getLastAssistantUsageInfo` scans forward and treats an assistant usage block as applicable only when its timestamp is not older than an already-inserted prefix message (for example, a compaction summary); `test/context-estimate.test.ts` covers stale and renewed usage.
- **Contract/behavior:** usage emitted before a newer inserted prefix describes the old larger context and cannot drive the next output budget. A later assistant response restores an applicable usage baseline.
- **Import evidence:** despite the nominal U2 package version, `/tmp/magenta-import-f1da4c/pi/coding-agent/src/core/agent-session.ts` already checks latest compaction timestamps and rejects stale usage in `_checkCompaction()` and context-usage reporting.
- **Current evidence:** current `agent-session.ts` retains and expands those guards: assistant-before-boundary early return, estimated usage source validation, and post-boundary context-usage checks. Current `pi/ai` does not yet have upstream's context-aware output-budget estimator at all, so the exact ai bug path is not active; Magenta's equivalent auto-compaction/context-display path is guarded.
- **Status:** **PRESENT** for the currently active Magenta behavior (independent/pre-existing implementation); the upstream ai utility itself is not present and becomes a required dependency if context-aware output budgeting is later imported.
- **Migration action/dependencies:** do not replace Magenta's timestamp/entry-aware guards with a narrower utility-only patch. If importing upstream context-aware output budgeting, port `getLastAssistantUsageInfo` and its tests at the same time, then keep the current branch-entry guards as defense in depth.
- **Tests:** retain current post-compaction tests; add an upstream-style estimator unit test plus same-timestamp boundary, retained pre-compaction assistant, and first post-compaction response cases.

### AG-015 - `Models` / `ModelRuntime` adaptation (cross-package architectural dependency)

- **Version / official text:** agent changelog has no 0.80.8 semantic bullet; direct agent change is the `docs/models.md` update in `9993c969...`. Coding-agent 0.80.8 official text: “Unified model runtime and provider authentication — `ModelRuntime` centralizes model configuration, provider-owned `/login`, and dynamic provider catalogs”; breaking SDK replacement of `authStorage`/`modelRegistry` with async `modelRuntime` and request auth through `ModelRuntime.getAuth()`.
- **SHA:** plan `c29bbc095829e352d8555527c553fb04928a571c`; implementation `9993c96907bb0c97260d2c353c31a3464f211122`; merge reconciliations `cd7cad4e...` and `5e336cfa...`.
- **Upstream files/symbols:** agent `docs/models.md`; ai `Models`, auth/store/runtime changes; coding-agent new `core/model-runtime.ts`, `provider-composer.ts`, `runtime-credentials.ts`, async SDK and session rewiring.
- **Contract/behavior:** `Models` remains the provider collection; `ModelRuntime` is the coding-agent-owned canonical facade composing credentials, provider config/extensions, dynamic catalogs, final auth/headers, login/logout, and refresh. SDK callers inject `modelRuntime`, not legacy storage/registry.
- **Import evidence:** import already contains pi-ai `Models`/`createModels` and the old Models-required AgentHarness, but coding-agent still has `ModelRegistry`/`AuthStorage`; no `ModelRuntime`.
- **Current evidence:** current pi-ai still has a valid `Models` runtime. Current coding-agent still has `core/model-registry.ts` with synchronous `refresh(): void`, `AuthStorage`, `external-auth-loader`, and no `model-runtime.ts`. HCP removed the old `AgentHarness` ecosystem (`72ddad9`) so that exact API is **SUPERSEDED**. HCP compaction still accepts `Models`, but coding-agent builds a partial object implementing only `completeSimple` and casts `as unknown as Models` in `harness-models-adapter.ts`, preserving explicit apiKey/headers/compat streaming.
- **Status:** **PARTIAL**. Core `Models` is present; `AgentHarness` is superseded; canonical `ModelRuntime` and full Models-backed request/auth ownership are missing, and the partial adapter is a migration conflict.
- **Migration action/dependencies:** treat as an architecture project, not a file copy. First define ownership among pi-ai provider auth, Magenta external auth, HCP, models.json, and extension providers. Replace the partial cast with a narrow HCP completion contract or a real configured `Models`. Then introduce `ModelRuntime` (or an explicitly equivalent Magenta facade), migrate SDK/session/login/refresh, and only then retire legacy registry/auth paths. AG-006 and AG-012 must be considered because provider concurrency and dynamic tool serialization depend on the selected runtime.
- **Tests:** credential precedence and refresh locking; external-auth compatibility; provider/header transform ordering; dynamic catalog persistence; SDK migration compile tests; login/logout/status; HCP compaction with a full runtime; Magenta peer/sub-agent/background-shell regression suite.

## Migration order

1. **Correctness/safety first:** AG-007, AG-008, AG-009, AG-010, AG-013.
2. **Session contract:** AG-004 then AG-005; AG-003 independently but before any custom-entry-dependent HCP feature.
3. **Next-turn API:** lock AG-002 with a regression test, then add AG-001 with Magenta's `hasMoreToolCalls` extension.
4. **Compaction:** resolve AG-006 without discarding current incremental/progress hardening; retain AG-014.
5. **Dynamic tools:** AG-012 after AG-008, across agent + ai serializers + HCP/coding-agent activation.
6. **Model architecture:** AG-015 only after an ownership decision and adapter contract; keep AG-011 as-is.

## Appendix A - every direct `packages/agent` path commit

The authoritative path log contains **33 commits** in `v0.80.2..v0.80.8`, including release/changelog/docs/test-only and merge topology commits.

| # | SHA | Classification | `packages/agent` effect / semantic mapping |
|---:|---|---|---|
| 1 | `8277bd68968d359dfd95726cc7bbc2fb3cc1aeeb` | mechanical | adds `[Unreleased]` to `CHANGELOG.md` after 0.80.2 |
| 2 | `c29bbc095829e352d8555527c553fb04928a571c` | docs/design | updates Models phase-9 plan; AG-015 precursor |
| 3 | `e547bb9f4180599629c45871c8311a51e1ec4f2f` | semantic | changes next-turn state refresh in `agent.ts`; precursor to AG-001/AG-002 |
| 4 | `fd6659dd5d32d67feaa7ce2ba5eeb87c5705149c` | semantic + changelog/test | splits context-aware callback from legacy signal callback; AG-001/AG-002 |
| 5 | `a23abe4a695df8b69b613f73e9fdda2a8af894d4` | release | 0.80.3 changelog finalization and package version bump |
| 6 | `dd87c02cbf2681c9301cf809146651483ff16030` | mechanical | adds next `[Unreleased]` section |
| 7 | `cbcf4e04c3f2e5822d9349fae9b7ba13a39bdefc` | semantic + changelog | oversized timeout validation; AG-009 part 1 |
| 8 | `85b7c24741096f147747689e21c4bc6892061824` | semantic | non-positive/non-finite timeout validation; AG-009 part 2 |
| 9 | `f58c11562605a21bcf3d3e45553c78fe105809f9` | semantic + changelog | serial split-turn summaries; AG-006 |
| 10 | `035ea9c8563dd15919134c56fde8d7808bacf08a` | mechanical refactor | removes redundant record guards in JSONL parsing; no public contract |
| 11 | `478301342b4c5fd4e2993d0c9b985cd60fb370ae` | test infrastructure | quiet dot reporter and failure-only output in `vitest.config.ts` |
| 12 | `1dac099022e764c0d400495597f688f7224ac2ee` | semantic + changelog | UUIDv7 random-tail IDs; AG-010 |
| 13 | `8c0ccd14b34b6e5c403363518e331094b69ebf6c` | semantic | null content normalization and result preservation; AG-008 |
| 14 | `351efc828b6fc5250fa50d6b32b20b0f0cb22cb4` | semantic + test | reject length-truncated tool calls; AG-007 |
| 15 | `7198e78f99d50776cce5368efe958e616f35156d` | semantic + tests | JSONL header metadata across storage/repo/types; AG-004 |
| 16 | `dd1c690f36de449fac9b24c8b3d113837eaf7cfb` | semantic + docs/tests | context entry transforms/projectors; AG-003 |
| 17 | `cb222bf99d209711b5546bf54931862f391418d0` | semantic/API | root storage exports; AG-005 |
| 18 | `bf75b8aa39fa0de5ec7a9e8e9e3791548d040d1c` | changelog audit | adds/finalizes official unreleased wording, including AG-003/AG-007/AG-008 |
| 19 | `912d0953f678bb50b0725e9c0ff65b65d4be97f5` | release | 0.80.4 changelog finalization and package bump |
| 20 | `ef793a983b708ba31718825b871dc93a63d4e3e1` | mechanical | adds next `[Unreleased]` |
| 21 | `cc62baa442b5c0333923fdfdcc1d7264f445b5b0` | release-only | 0.80.5 empty agent section and package bump; no semantic item |
| 22 | `e3513193bf21d91320f5729a3bdf42b21cabe2dd` | mechanical | adds next `[Unreleased]` |
| 23 | `fbdd46389c3a0c03b62f5e9eabe31a85044ef8ce` | semantic + docs | adds `max` to agent type; AG-011 |
| 24 | `2b3fda9921b5590f285165287bd442a25817f17b` | release | 0.80.6 changelog finalization and package bump |
| 25 | `34582ef34beec868b0df4fb969385b8af5960c45` | mechanical | adds next `[Unreleased]` |
| 26 | `3d8f74357c169d24f996a1611ecc4be72b7744bd` | semantic cross-package | `addedToolNames` agent propagation plus ai/coding-agent protocol; AG-012 |
| 27 | `4c1861033b63a04563547ccdb5ed2bf31d4fdcd3` | changelog audit | adds official AG-012 wording |
| 28 | `9993c96907bb0c97260d2c353c31a3464f211122` | docs in agent; semantic elsewhere | updates `docs/models.md`; full ModelRuntime work is ai/coding-agent; AG-015 |
| 29 | `818d67457cdd6b60bce6b121d16b23141c252dd8` | release | 0.80.7 changelog finalization and package bump |
| 30 | `9d09075c53812f7af955ce4397d0508c4a62efac` | mechanical | adds next `[Unreleased]` |
| 31 | `cd7cad4ee285ad93549794542ba23334963b3b91` | merge topology + semantic reconciliation | two-parent merge of origin/main into ModelRuntime facade: relative to its ModelRuntime parent it brings the 0.80.6 release metadata plus AG-008 result preservation and AG-012 `addedToolNames`; relative to the origin parent it reconciles 40 lines of `docs/models.md` |
| 32 | `5e336cfa808c7b6056f168d42482c27f3acfc5cc` | merge topology + release reconciliation | second two-parent ModelRuntime merge: relative to its feature parent it brings agent 0.80.7 changelog/package metadata; relative to the origin parent it reconciles the same 40-line Models document divergence |
| 33 | `fae7176cb9f7c4725a40d9d481d8d70b80f18086` | release-only | 0.80.8 empty agent section and package bump; no semantic item |

## Appendix B - required cross-package commits

| SHA | Why it is agent-upgrade relevant |
|---|---|
| `d7868b099853a68f4fdb94f05e6913760dde3f7e` | adds and populates `Usage.reasoning`; agent/harness consume the resulting assistant usage contract (AG-013) |
| `8973ae28ab926c43d4088d837b19b8093359e54b` | prevents pre-compaction assistant usage from influencing post-compaction budgets (AG-014) |
| `9993c96907bb0c97260d2c353c31a3464f211122` | already in Appendix A due agent docs, but its actual runtime changes span ai/coding-agent and introduce ModelRuntime (AG-015) |

## Coverage/self-check

- Official non-empty agent bullets counted from U8 changelog: 0.80.3 = 2, 0.80.4 = 8, 0.80.6 = 1, 0.80.7 = 1, total **12**. Mapping: AG-001 through AG-012 exactly once.
- Empty sections explicitly checked: 0.80.5 and 0.80.8; no invented semantic items.
- Direct path-log commit count: **33**, Appendix A rows: **33**.
- Cross-package requested contracts: Usage propagation (AG-013), compaction usage (AG-014), Models/ModelRuntime (AG-015).
- Static checks used: tag-to-tag changelog/diff, reverse path log including merges, per-commit name-status/patch inspection, U2/U8 source comparison, import snapshot symbol/hash checks, `git show f1da4c9:harness/...`, current source searches, current blame/log evidence.
- No source files were modified. No runtime test suite was executed because this assignment is a read-only migration analysis; proposed tests are listed per item.
