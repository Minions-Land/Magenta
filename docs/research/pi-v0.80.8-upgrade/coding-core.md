# coding-agent core/runtime upgrade analysis (v0.80.2 -> v0.80.8)

## 0. Scope, baselines, and method

- Owned scope: `packages/coding-agent/src/core/**`, `src/main.ts`, `src/index.ts`, `src/migrations.ts`, package exports/resources, and directly coupled tests/docs.
- Upstream evidence was read from `/tmp/magenta-pi-upstream-v0.80.8-20260717` at tags `v0.80.2=0201806a`, `v0.80.3=a23abe4a`, `v0.80.4=912d0953`, `v0.80.5=cc62baa4`, `v0.80.6=2b3fda99`, `v0.80.7=818d6745`, `v0.80.8=fae7176c`. The checkout HEAD is newer, so every diff/log conclusion below is tag-bounded.
- Comparison trees: U2 `/tmp/magenta-pi-v0802`; U8 `/tmp/magenta-pi-v0808` plus tag-bounded Git evidence; Magenta import I `/tmp/magenta-import-f1da4c/pi`; Magenta current C `$HOME/Magenta3@4a08f63/pi`.
- `v0.80.5` has no coding-agent changelog content; its only scoped change is the package version release commit.
- Classification: **ADOPTED** = behavior is present in C (possibly via a Magenta implementation); **PARTIAL** = some contract is present but not the upstream contract; **PORT** = absent and can be adapted; **CONFLICT** = absent or incompatible and requires architecture-aware redesign; **DEPENDENCY** = implementation is in pi-ai/pi-agent/TUI/modes but core consumes the contract; **NO-OP** = mechanical/release-only.

## 1. Executive finding

The upgrade is not a normal six-patch merge. I and C still publish `0.80.2` and retain the synchronous `AuthStorage + ModelRegistry` SDK contract. C has substantial post-import Magenta changes: external credential discovery, HCP package/tool assembly, harness-delegated compaction, background/peer/sub-agent tools, Ultra execution profiles, cache telemetry, SSH operations, and a larger default native tool set. U8 replaces the auth/model center with async `ModelRuntime`, provider-owned auth, `Models.refresh()`, and dynamic catalog storage.

Highest conflicts, in order:

1. **ModelRuntime vs external-auth (CC-048..CC-053):** C's `external-auth-loader.ts` injects environment, Claude Code, and Codex credentials and base URLs into `AuthStorage`/`ModelRegistry`. U8 deletes those SDK exports and delegates credential resolution to pi-ai provider auth through a `CredentialStore`. A direct replacement silently loses Claude/Codex file discovery and custom base URL/model precedence.
2. **Compaction/session storage (CC-005, CC-007, CC-017, CC-024, CC-034, CC-039, CC-043):** C delegates compaction to `@magenta/harness` through `harness-models-adapter.ts`; upstream patches the old local implementation. The behavior must be placed in the harness owner or adapter, not copied into the now-thin pi files.
3. **Extension lifecycle/rendering (CC-010, CC-016, CC-026, CC-027, CC-033):** C preserved the old extension type surface but added internal built-in message renderers and HCP reload lifecycle. Upstream adds public entry renderers and settlement/header hooks. These need to coexist with current renderer registry and shutdown/external-activation semantics.
4. **Dynamic/message-anchored tools (CC-012, CC-041):** C dynamically loads package, HCP, MCP, peer, background, and teammate tools, but does not emit `addedToolNames`; U8's cache-preserving protocol only observes additive activation during a tool result. The wrapper must cover all Magenta tool sources without changing `--tools`, `--exclude-tools`, or `noTools` behavior.
5. **Built-in/package resources (CC-008, CC-025, CC-044, CC-057):** C packages HCP `skills/sandbox/tools/policy/runtime` assets and defaults to eleven native tools, not upstream's four. U8 package.json or SDK defaults cannot replace C wholesale.

A file-level census reinforces this: all new U8 core files (`model-runtime.ts`, `model-config.ts`, `models-store.ts`, `provider-composer.ts`, `remote-catalog-provider.ts`, `runtime-credentials.ts`, `radius.ts`, `cache-stats.ts`) are absent in I and C. C still exports `AuthStorage` and accepts `CreateAgentSessionOptions.authStorage/modelRegistry`; it has no `ModelRuntime`, `refreshModels`, `before_provider_headers`, `agent_settled`, `EntryRenderer`, or `addedToolNames` symbols.

## 2. CC records: v0.80.3

**CC-001 - benchmark timing shutdown ordering**

Version/official: 0.80.3, “Fixed startup benchmark timing output to print after TUI shutdown, preserve extension timings, and drain terminal-query replies before stopping benchmark mode.” SHAs: `63386614`, `0bdbe7c5`, `d8a2cab3` (plus first-parent merge `5c76ae40`). Upstream: `main.ts`, `core/extensions/loader.ts`, `resource-loader.ts`, `timings.ts`; timing collection survives extension load and output occurs after TUI stop/drain. I: U2. C: `timings.ts` remains U2 while `main.ts/resource-loader.ts` are Magenta-custom; no upstream sequence evidence. Class: **PORT**. Action: transplant ordering, not whole `main.ts`; preserve HCP reload timing and headless stdout ownership. Dependency/tests: direct upstream behavior has startup benchmark tests outside core; add a Magenta subprocess test asserting timing is last output and no terminal replies leak.

**CC-002 - explicit provider retry errors**

Version/official: 0.80.3, “Fixed auto-retry for provider stream errors that explicitly tell callers to retry the request.” SHA: `371adcf3`. Upstream: `AgentSession._handleAgentEvent` treats explicit retry metadata/message as retryable; regression `6019-explicit-provider-retry-message.test.ts`. I: U2. C: heavily modified agent session, no scoped upstream hunk provenance. Class: **PORT**. Action: adapt the small retry classifier into C's existing retry/background-settlement flow. Dependency/tests: pi-ai error shape; port regression and ensure an external activation is not consumed twice during retry.

**CC-003 - BMP disk images**

Version/official: 0.80.3, “Fixed disk BMP image files to be detected, converted to PNG, and attached through `read` and CLI `@file` inputs.” SHA: `4cc339f5`. Upstream: `tools/read.ts` image conversion path; tests `block-images`, `image-process`, `tools`. I: U2. C: current `tools/read.ts` has no BMP/image conversion symbol; clipboard BMP conversion exists but is a different path. Class: **PORT**. Action: reuse current image utility/worker and SSH byte-reading abstraction; do not duplicate clipboard-only code. Test local and SSH BMP read, blocked-images setting, malformed BMP.

**CC-004 - deterministic no-session IDs**

Version/official: 0.80.3, “Fixed `--no-session --session-id` so ephemeral CLI runs can use deterministic session IDs for provider cache affinity.” SHA: `e454f50b`. Upstream: `SessionManager.inMemory(cwd, id)` and `main.ts`; tests `session-id-readonly` and `custom-session-id`. I already has custom session-id changes relative to U2; C expands them further. Class: **PARTIAL**. Action: behavior-test C rather than copy; ensure no file reservation/write, and feed the ID into ModelRuntime/cache telemetry after CC-048. Tests: CLI subprocess with both flags and provider stream assertion.

**CC-005 - reject invalid session files**

Version/official: 0.80.3, “Fixed `--session` and `SessionManager.open()` to reject non-empty invalid session files without overwriting them.” SHAs: `543710f6`, message shortening `0d145e89`. Upstream: strict `SessionManager.open()` validation and `main.ts`; `session-file-invalid.test.ts`. I/C `parseSessionEntryLine` still skips malformed lines and current session code is extensively customized. Class: **CONFLICT**. Action: introduce strict validation only at explicit open/import boundaries while retaining tolerant streaming readers for already-open append-only sessions; preserve original bytes on failure. Tests: empty file allowed, malformed non-empty rejected, invalid header rejected, trailing corrupt line policy explicit, no overwrite.

**CC-006 - default OpenAI model**

Version/official: 0.80.3, “Changed the default OpenAI model to `gpt-5.5`.” SHA: `77428858`. Upstream: `model-resolver.ts/defaultModelPerProvider`. I: U2. C has a custom model resolver and current generated catalogs. Class: **DEPENDENCY/PARTIAL**. Action: once U8 catalogs are imported, use provider metadata/default selection rather than hard-code a stale ID; verify current Ultra/model-scope semantics. Test authenticated OpenAI selection with and without saved default.

**CC-007 - pre-prompt compaction stops**

Version/official: 0.80.3, “Fixed pre-prompt compaction to stop after compaction instead of continuing immediately.” SHA: `73581ea9` plus merge `a8c692c7`. Upstream: `_checkCompaction()` result makes `prompt()` return after compaction; regression `pre-prompt-compaction-no-continue`. I: U2. C has a different compaction/external-activation queue and delegates compaction. Class: **CONFLICT**. Action: encode the stop/continuation contract in AgentSession's orchestration layer; do not move it into harness summarization. Tests: exactly one provider call for compaction, no original prompt call until resumed/queued, background returns remain queued.

**CC-008 - RPC tree access and package export**

Version/official: 0.80.3, “Added `get_entries` and `get_tree` RPC commands…” and “Added a package `./rpc-entry` export…”. SHAs: `7ba1b6bf`, `122527b2`, merge `234c2ad5`. Upstream: RPC surface plus root `index.ts`; `package.json` adds `./rpc-entry`, build chmod, and entrypoint. I/C have no `get_entries`, `get_tree`, or `rpc-entry`; C package exports only `.` and custom release assets. Class: **PORT/CONFLICT(package)**. Action: port RPC methods/entrypoint, then merge export/build edits into Magenta package scripts while retaining `magenta` binary and HCP release resources. Tests: RPC tree/entries, package export resolution after build, binary resources still present.

**CC-009 - external editor setting**

Version/official: 0.80.3, “Added an `externalEditor` settings.json override…”. SHA: `5a073885`. Upstream: `Settings.externalEditor` getter/setter and UI selection; settings/keybindings/usage docs. I/C have the keybinding name but no setting/getter. Class: **PORT**. Action: add settings contract and let interactive editor resolve configured value before `$VISUAL/$EDITOR`; retain Magenta config dir. Test precedence and platform defaults.

**CC-010 - extension session-name event**

Version/official: 0.80.3, “Added session-name change events for extensions.” SHA: `726a9c52` (first-parent merge `939c39ab`). Upstream: `SessionInfoChangedEvent`, public exports, `setSessionName()` emits internally and to extension runner; regression `3686-session-name-event`. C emits only the internal `AgentSessionEvent`; extension types/export lack the event. Class: **PARTIAL/PORT**. Action: preserve the internal event and emit through the current active extension runtime after persistence; normalize name once. Test internal + extension listeners receive one identical event, including newline normalization.

**CC-011 - output padding**

Version/official: 0.80.3, “Added an `outputPad` setting for user message, assistant message, and thinking horizontal padding.” SHAs: `6564d947`, `9be55bc7`. Upstream: settings contract plus TUI renderers; tests `assistant-message`, `settings-manager`, `5943`. I/C lack setting. Class: **PORT**. Action: add core setting and pass through current renderers; clamp/validate so compact panels do not overflow. Tests all three message types and narrow terminal.

**CC-012 - extension tool refresh before next request**

Version/official: 0.80.3, “Fixed extension tool changes to apply before the next provider request in the same agent run without dropping `before_agent_start` system-prompt overrides.” SHAs: `e547bb9f`, `fd6659dd`. Upstream: refresh session/agent state after tool execution while preserving run prompt; regression renamed to `6162-extension-active-tools-next-turn`. C has richer reload/package/MCP activation but no upstream run-prompt preservation evidence. Class: **CONFLICT**. Action: add a focused state transition to current `_buildRuntime`/reload path; retain HCP overlays and external activation receipts. Test tool adds/removes during run, system prompt override survives, explicit allow/deny filters survive.

**CC-013 - undici mid-stream termination**

Version/official: 0.80.3, “Fixed a crash when undici emits an internal client error while terminating a mid-stream HTTP response.” SHA: `2117b61c`. Upstream: `http-dispatcher.ts` installs an error listener/guard. C has custom Node-26/npm-undici installation but no client-error guard. Class: **CONFLICT**. Action: adapt guard to current dispatcher installation without swallowing real request failures or adding duplicate listeners. Test synthetic dispatcher client error during abort and listener count across reconfigure.

## 3. CC records: v0.80.4 and empty v0.80.5

**CC-014 - bash timeout validation**

Version/official: 0.80.4, “Fixed non-positive or oversized bash tool timeouts to fail with a clear validation error…”. SHAs: `cbcf4e04`, `85b7c247`. Upstream: validate positive timeout and Node timer maximum; tool tests. C's bash tool is rewritten for auto-promotion/background execution and does not contain the upstream checks. Class: **CONFLICT**. Action: validate at the foreground bash schema/executor boundary and separately validate bg-shell seconds; preserve auto-promotion. Test `0`, negative, >2^31-1, fractional, foreground/background.

**CC-015 - public model resolution helpers**

Version/official: 0.80.4, “Added public SDK exports for CLI-equivalent model and scoped-model resolution.” SHA: `040f0a51`. Upstream: exports `resolveCliModel`, `resolveModelScopeWithDiagnostics`, associated types. C has custom async `resolveModelScope` internally but root index does not export the U8 helpers. Class: **CONFLICT**. Action: expose Magenta's execution-profile-aware resolver with U8-compatible names/result diagnostics after ModelRuntime conversion. Test root import and `ultra` handling.

**CC-016 - persisted entry renderers**

Version/official: 0.80.4, “Added extension entry renderers for persisted display-only session entries…”. SHA: `ba10b60b`. Upstream: `EntryRenderer`, `registerEntryRenderer`, loader/runner map, SessionManager context exclusion, root exports; direct discovery/runner/build-context tests. C has internal built-in **message** renderers and renderer registry but no entry-renderer API. Class: **CONFLICT**. Action: unify entry and current renderer registries behind one lookup while preserving display-only/no-model-context semantics; avoid card nesting/TUI ordering regressions. Tests persistence, resume, pending tool render, absent renderer fallback, XSS-safe HTML export if exposed.

**CC-017 - serialize split-turn summaries**

Version/official: 0.80.4, “Fixed split-turn compaction to serialize summary requests so single-concurrency local providers do not fail with 429 errors.” SHA: `f58c1156`. Upstream replaces `Promise.all` with sequential history then prefix summaries. C delegates compaction to `@magenta/harness`. Class: **CONFLICT(owner moved)**. Action: inspect/patch harness compaction implementation, leaving pi adapter thin. Test a provider that rejects concurrent calls and assert call order.

**CC-018 - auth persistence errors**

Version/official: 0.80.4, “Fixed `/login` to report auth storage persistence failures…”. SHA: `f8bec25f`. Upstream: `AuthStorage` records/drains errors; login UI consumes them. I/C AuthStorage is custom and already has `errors`/`drainErrors` (current evidence shows these symbols), so core storage portion is present; provider-owned U8 login changes the reporting point. Class: **PARTIAL**. Action: preserve error propagation when wrapping external credentials in a new CredentialStore and test `/login` after CC-049. Do not claim success before `modify()` persists.

**CC-019 - skip unauthenticated saved default**

Version/official: 0.80.4, “Fixed startup model selection to skip unauthenticated saved defaults…”. SHA: `ca09b2b1`. Upstream: model resolver checks configured auth. C resolver is custom and external auth changes configured status. Class: **PARTIAL/CONFLICT**. Action: base selection on ModelRuntime `checkAuth` snapshot plus external-store status; preserve local configured models. Tests stored default without auth, ambient env auth, Claude/Codex external auth, local no-key provider.

**CC-020 - remove Vercel attribution headers**

Version/official: 0.80.4, “Removed default attribution headers from Vercel AI Gateway requests.” SHA: `83cbfc65`. Upstream: `provider-attribution.ts` removal and SDK attribution tests. C still has `isVercelGatewayModel()` and tests expecting default Vercel headers. Class: **CONFLICT**. Action: deliberately choose upstream privacy/compat behavior and update tests; do not let later ModelRuntime header transform re-add them. Test OpenRouter attribution remains, Vercel absent.

**CC-021 - permissive edit replacement fields**

Version/official: 0.80.4, “Fixed the edit tool schema to allow model-invented extra replacement fields…”. SHA: `a1b336d7`. Upstream: replacement object schema permits extra fields. C has a custom batched `edits[]` plus legacy single replacement normalization. Class: **CONFLICT**. Action: make each edit item tolerate unknown fields while keeping exact-match, uniqueness, and overlap validation. Tests extra field in batch and legacy form.

**CC-022 - keybinding guard cleanup**

Version: 0.80.4; no standalone changelog line. SHA: `035ea9c8`. Upstream removes redundant record guards in `keybindings.ts`. C keybindings are custom. Class: **NO-OP/mechanical**. Action: do not cherry-pick; formatter/typecheck will decide.

**CC-023 - clear label timestamp cache**

Version/official: 0.80.4, “Fixed new session resets to clear cached label timestamps.” SHA: `6efc09b7`. Upstream: clear `labelTimestampsById` during reset. C's current rebuild path clears the map, but new-session/reset behavior should be asserted. Class: **PARTIAL**. Action: behavior-test current `newSession` and preserve labels in fork/compact paths. Tests stale timestamp cannot leak into a new file.

**CC-024 - normalize null message content**

Version/official: 0.80.4, “Fixed `null` message content from imported transcripts or custom clients to normalize at ingestion boundaries…”. SHA: `8c0ccd14` (pi-ai/agent also changed). Upstream: AgentSession/SessionManager boundary normalization; `lax-message-content.test.ts`. C search finds no normalization and uses custom peer/custom messages. Class: **CONFLICT**. Action: normalize at all ingestion points (session load, agent event, RPC/import) before peer envelope and harness compaction. Tests null user/assistant/tool/custom content and persisted round trip.

**CC-025 - project-local resource configuration**

Version/official: 0.80.4, “Added project-local resource override management to `pi config`…”. SHA: `c8ada4e7`. Upstream: package/settings scope behavior and config UI; package path/manager docs/tests. C already has project/global settings, trust gating, HCP packages, acquisition, package tools, and `.magenta` paths. Class: **ADOPTED/PARTIAL**. Action: do not import files; compare only missing CLI affordances (`-l`, Tab scope switching) in the modes owner. Core must retain current precedence: project first, trust-gated, HCP/package/MCP sources. Existing C package-manager tests are stronger and include project scope.

**CC-026 - named InlineExtension**

Version/official: 0.80.4, “Added an `InlineExtension` type for named inline extension factories.” SHA: `b3dff19a`. Upstream: union type, resource loader factory naming/cache, root exports; regression `6260-inline-extension-naming`. C has no symbol and has HCP reload/module caching. Class: **CONFLICT**. Action: add union type and stable name into current loader cache identity; verify it does not collide with internal built-in renderer extensions. Test two named factories, anonymous fallback, reload creates fresh instances.

**CC-027 - before_provider_headers**

Version/official: 0.80.4, “Added `before_provider_headers` extension hook support…”. SHA: `244f1dea`. Upstream: event type, runner mutates headers, SDK routes it through `ModelRuntime.streamSimple(transformHeaders)` after attribution. C has `before_provider_request`, cache telemetry, attribution, and direct `streamSimple`; no header hook. Class: **CONFLICT**. Action: after CC-050, order must be provider/config/model auth headers -> attribution policy -> extension header transform -> cache/wire observation -> dispatch. Define case-insensitive deletion/override behavior. Tests uppercase duplicates, async hook, hook error, cache fingerprint of final headers/payload.

**CC-028 - `/login <provider>` arguments**

Version/official: 0.80.4, “Added `/login <provider>` support with provider autocomplete.” SHA: `312bc713`. Upstream: slash command parsing; direct interactive status tests. C slash commands are custom and provider auth remains registry-owned. Class: **PORT now, superseded by CC-049**. Action: implement against provider-owned auth discovery, not legacy OAuth registry. Test unknown, ambient-only/info, API key, OAuth, autocomplete.

**CC-029 - modelOverrides on extension providers**

Version/official: 0.80.4, “Fixed `models.json` `modelOverrides` to apply to extension-registered provider models.” SHA: `c6251a86`. Upstream U8 ultimately applies overrides last in `provider-composer.getModels`. C has custom registry plus external baseUrl overlays. Class: **CONFLICT**. Action: rely on U8 composer ordering: built-in -> models.json custom/upsert -> extension replacement -> credential projection -> `modelOverrides` last. Add external-auth baseUrl as auth result, not a model override. Tests precedence and re-registration.

**CC-030 - stable Windows context traversal**

Version/official: 0.80.4, “Fixed project context file discovery to use stable parent traversal on Windows…”. SHA: `2170363a`. Upstream: `resource-loader.ts`; regression in resource tests. C resource loader is HCP/async and custom. Class: **CONFLICT**. Action: reuse current path utilities and terminate at stable root/UNC boundary; apply to all AGENTS/CLAUDE/HCP discovery. Test drive root, UNC, symlink, cwd `$HOME`.

**CC-031 - session-id creation warning**

Version/official: 0.80.4, “Fixed `--session-id` startup to warn when no existing project session has that id…”. SHA: `c4281a7d`. Upstream: `main.ts`; session-id subprocess test. C has stricter custom validation and collaboration IDs. Class: **PARTIAL**. Action: warn only for user CLI creation, not managed teammate IDs or explicit no-session IDs. Test all three paths.

**CC-032 - reload descriptions**

Version/official: 0.80.4, “Fixed `/reload` help text and docs to consistently mention themes and context files.” SHA: `1ffca0f2`. C intentionally split `/refresh` and `/reload` and added HCP resources. Class: **CONFLICT/docs**. Action: retain Magenta semantics; update its own descriptions to enumerate actual refreshed/restarted resource types rather than copying Pi text. Test command metadata snapshot.

**CC-033 - settled agent lifecycle**

Version/official: 0.80.4, “Added extension and RPC `agent_settled` events plus session-level idle waiting for fully settled agent runs.” SHA: `e9fa5a68`. Upstream: emits only after retry/compaction/queued continuation is done, resolves idle wait afterward; regression `6363-agent-settled-event`. C has background idle and external activation coordinator but no agent-settled event. Class: **CONFLICT/high**. Action: define “settled” across foreground agent, retries, compaction, queued messages, external activation, and optionally background work. Preserve upstream minimum contract (foreground continuation settled); expose background status separately unless explicitly folded in. Test event order, exactly once, extension async handler, signal shutdown, urgent mailbox wake.

**CC-034 - context-visible custom messages in compaction**

Version/official: 0.80.4, “Fixed compaction retained-token budgeting to count context-visible custom messages.” SHA: `a6f720e6`. Upstream: projects entries through `sessionEntryToContextMessages` for cut points/budget. C delegates to harness and has peer/bg custom messages. Class: **CONFLICT/high**. Action: make harness projection the single source of truth and include only model-visible custom messages; hidden teammate receipts/display-only entries must not consume budget. Test visible peer/bg messages, hidden receipts, branch/compaction summaries.

**CC-035 - prompt cache miss notices**

Version/official: 0.80.4, “Added a `showCacheMissNotices` setting and `/settings` toggle…”. SHA: `3f9aa5d1`. Upstream: `cache-stats.ts`, AgentSession stats/notices, setting; `cache-stats.test.ts`. C lacks `cache-stats.ts`/setting but has richer `cache-telemetry.ts`. Class: **CONFLICT/possible supersession**. Action: feed user-visible significant-miss detection from current telemetry instead of adding parallel accounting; preserve privacy and env controls. Test threshold, reset, compact boundary, provider without cache usage.

## 4. CC records: v0.80.6

**CC-036 - `max` thinking level**

Version/official: 0.80.6, “Added the opt-in `max` thinking level across CLI, SDK, RPC, model selection, and themes.” SHA: `fbdd4638` (cross-package). Upstream scoped files: model registry/settings plus broad tests/docs. C already has `max` in model registry, AgentSession, themes, CLI tests and sub/teammate tools, introduced independently (`c97d255` and later work); C also adds `ultra`. Class: **ADOPTED**. Action: retain current `ultra -> native max/xhigh/...` resolution and verify U8 provider maps do not collapse Ultra. Tests already present; add catalog-driven Fable/GPT mapping after dependency upgrade.

**CC-037 - input-based pricing tiers**

Version/official: 0.80.6, “Added request-wide input-token pricing tiers to custom model costs in `models.json`, `modelOverrides`, and extension-registered providers.” SHA: `a9ecf301` (pi-ai + coding types). C search finds no `tiers` type/config support. Class: **DEPENDENCY/PORT**. Action: upgrade pi-ai cost types first, then carry `cost.tiers` through model config/composer and Magenta usage/cache telemetry. Test boundary token counts and extension/modelOverrides serialization.

**CC-038 - `~` expansion for shellPath**

Version/official: 0.80.6, “Added `~` (home directory) expansion for the `shellPath` setting.” SHA: `1a2542b1`. C getter returns raw string. Class: **PORT**. Action: expand only leading `~`/`~/`, retain Windows/SSH shell selection semantics. Test Unix, Windows, literal mid-path tilde.

**CC-039 - post-compaction output budget**

Version/official: 0.80.6, “Fixed inherited post-compaction output-token budgeting to ignore stale assistant usage from before the compaction boundary.” Dependency SHA: `8973ae28` in pi-agent/ai, not a coding-core commit. C's compaction/session is heavily customized and uses harness. Class: **DEPENDENCY/CONFLICT**. Action: upgrade agent dependency and verify C's restored message state exposes the compaction boundary correctly. Test large stale pre-compact usage followed by small post-compact turn.

## 5. CC records: v0.80.7

**CC-040 - message copy and clipboard fallback**

Version/official: 0.80.7, “Added `Ctrl+X` to copy the last assistant message…” and “Fixed `Ctrl+V` to paste clipboard text when the pasteboard does not contain an image.” SHAs: `3b686ac2`, `d7a48d30`. Scoped core: extension runner/keybindings; UI/tests elsewhere. C keybindings/runner are custom and lacks direct evidence of these exact behaviors. Class: **PORT**. Action: port UI owner behavior while merging keybinding IDs; do not collide with Magenta shortcuts. Test transcript/tree branches and text-only/image clipboard.

**CC-041 - cache-friendly message-anchored dynamic tools**

Version/official: 0.80.7, “Added cache-friendly dynamic tool loading for extension tools activated by tool results.” SHA: `3d8f7435`. Upstream: runner exposes active tools; wrapper snapshots before/after execution and returns additive `addedToolNames`; compat schema adds `supportsToolSearch`/`supportsToolReferences`; pi-agent/pi-ai perform anchor encoding/fallback. C has dynamic Package/HCP/MCP tools but no these symbols. Class: **CONFLICT/high**. Action: upgrade agent/ai first, then wrap every Magenta tool definition whose execution can activate tools. Only emit when old set is a subset of new; removal/non-additive changes use full fallback. Preserve explicit filters and default tool activation. Tests extension, package, HCP, MCP activation; removal; unsupported model; Anthropic/OpenAI cache-prefix behavior.

**CC-042 - session affinity format**

Version/official: 0.80.7 breaking, “Removed `compat.sendSessionIdHeader`; use `compat.sessionAffinityFormat` (`openai`, `openai-nosession`, `openrouter`).” SHA: `298665cf` (coding registry schema + pi-ai). C's registry still carries the old compatibility schema. Class: **DEPENDENCY/PORT**. Action: migrate models.json validation/data and any generated catalogs; preserve Magenta deterministic session IDs and cache telemetry. Test OpenRouter `x-session-id`, OpenCode no session header, OpenAI normal affinity.

**CC-043 - branch summaries with ambient auth**

Version/official: 0.80.7, “Fixed branch summaries to work with providers that use ambient authentication instead of API keys.” SHA: `7303cbac`. Upstream changes required auth to optional and uses summarization request auth. C `GenerateBranchSummaryOptions.apiKey` is still required and its harness adapter injects explicit auth. Class: **CONFLICT/high**. Action: after ModelRuntime, pass a `Models` facade/provider auth into harness summarization rather than requiring key strings. Test Bedrock SigV4/Cloudflare ambient auth, extension headers, cancellation.

**CC-044 - npm removal with peer conflicts**

Version/official: 0.80.7, “Fixed npm package removal when installed packages have conflicting peer dependencies.” SHA: `b084d2fb`. Upstream adds `--legacy-peer-deps` to uninstall. C already uses `--legacy-peer-deps` for managed install and has extensive package tests, but removal path must be checked explicitly. Class: **ADOPTED/PARTIAL**. Action: ensure both install and uninstall builders use the policy; keep bun/pnpm/HCP behavior. Test conflicting-peer uninstall.

**CC-045 - Radius gateway**

Version: introduced by `961fa6c1`, officially surfaced in 0.80.8 as “Radius gateway support including offline migration…”. Upstream U7 adds `radius.ts`, registry/resolver/display changes; U8 folds it into provider-owned ModelRuntime. I/C have no Radius symbols. Class: **CONFLICT/PORT with CC-052**. Action: do not port U7 registry implementation; use U8 provider factory and store migration after external-auth design. Tests OAuth gateway config, custom provider ID, offline cached catalog.

**CC-046 - stable system prompt cache across dates**

Version/official: 0.80.7, “Fixed system prompt cache invalidation across dates by removing the current date from the default prompt.” SHA: `f4e9ca74`. C system prompt is Magenta/harness-custom. Class: **PARTIAL/CONFLICT**. Action: verify date is not injected by pi, harness packages, or HCP prompt assembly; remove only volatile default date, not user-provided date context. Test deterministic prompt across mocked days.

**CC-047 - Bedrock API-key login**

Version/official: 0.80.7, “Fixed `/login amazon-bedrock` to prompt for and save a Bedrock API key instead of only displaying ambient AWS credential setup instructions.” Dependency SHA: `3ea064ea` (UI/auth integration outside owned paths), later generalized by provider-owned auth. C external auth does not cover AWS. Class: **DEPENDENCY with CC-049**. Action: rely on provider auth methods and keep ambient SigV4 distinct from stored API key. Test both choices and logout.

## 6. CC records: v0.80.8 runtime/model/auth

**CC-048 - async ModelRuntime SDK boundary**

Version/official: 0.80.8 breaking, “Replaced `CreateAgentSessionOptions.authStorage` and `modelRegistry` with async `modelRuntime`… AuthStorage backends are no longer exported; use ModelRuntime/custom CredentialStore/readStoredCredential.” Primary SHA: `9993c969`; conflict/merge commits `cd7cad4e`, `ff28097a` (first-parent model-runtime facade), `5e336cfa`. Upstream: new `model-runtime.ts`, `runtime-credentials.ts`, rewired `sdk.ts`, AgentSession services/session/main/index; `readStoredCredential` is the narrow public auth read. I/C retain old options/exports. Class: **CONFLICT/critical**. Action: introduce a Magenta `CredentialStore` adapter first, add `modelRuntime` while temporarily accepting deprecated old options internally, migrate all call sites/tests, then remove public old exports in a deliberate breaking release. Preserve custom SDK options (`sshTarget`, executionProfile/Ultra, HCP capabilities/tools). Tests: SDK compile/API exports, in-memory custom store, concurrent refresh, old-option deprecation window.

**CC-049 - provider-owned auth and `/login` discovery**

Version/official: 0.80.8, “Added provider-owned `/login` discovery directly from registered pi-ai providers, including ambient auth status and informational links.” SHA: `9993c969` plus provider dependencies. Upstream symbols: `Models.getProviders/checkAuth/login/logout`, `ModelRuntime.getProviderAuthStatus`; built-ins retain exact auth methods when no overlays. I/C auth is global registry/OAuth plus external file discovery. Class: **CONFLICT/critical**. Action: implement `ExternalCredentialStore`/auth-context bridge with explicit precedence: runtime override > stored Magenta auth > external Claude/Codex files > provider environment/ambient. External `baseUrl` must be returned as request auth, never mutate immutable catalogs. Avoid treating Codex ChatGPT token as generic OpenAI unless provider auth explicitly supports it. Tests every source, collision precedence, refresh locking, logout must not delete external files.

**CC-050 - final request auth/header assembly**

Version/official: 0.80.8 breaking/changed, “Replaced `ModelRegistry.getApiKeyAndHeaders()` with `ModelRuntime.getAuth()`” and “ModelRuntime owns final request assembly… `before_provider_headers` runs as the Models-only header transform.” SHA: `9993c969`. Upstream: `ModelRuntime.getAuth(model)` merges provider auth with configured per-model headers case-insensitively; `prepareRequest()` resolves once, applies transform, then dispatches. C directly calls registry and streamSimple, with attribution/cache telemetry/custom timeouts. Class: **CONFLICT/critical**. Action: make ModelRuntime the sole auth resolver but keep Magenta timeout/session/cache instrumentation around `modelRuntime.streamSimple`. Define header precedence and deletion once. Test one auth resolution per stream, uppercase duplicates, request overrides, Cloudflare env-derived URL, telemetry observes final request.

**CC-051 - model composition and async refresh contract**

Version/official: 0.80.8 breaking, “Changed extension-facing `ModelRegistry.refresh()` from synchronous `void` to `Promise<void>`…” and “Moved canonical dynamic catalog refresh to async `ModelRuntime.refresh()`/Models.refresh()`.” SHA: `9993c969`; merge `cd7cad4e`. Upstream: immutable models.json `ModelConfig`, built-in + extension composition, synchronous registry compatibility reads backed by async runtime snapshot. I/C registry refresh is synchronous and also injects external base URLs. Class: **CONFLICT/critical**. Action: migrate resource/extension reload to await runtime refresh before reads; retain a compatibility `ModelRegistry` wrapper only for extension API. Audit all C call sites that assume synchronous reload. Tests stale read before await, fresh read after await, concurrent coalescing, extension unregister restoration.

**CC-052 - models-store, remote catalogs, Radius migration**

Version/official: 0.80.8, “Added file-backed dynamic catalogs in `models-store.json`, per-provider pi.dev catalog overlays, and Radius gateway support including offline migration from legacy credential-cached catalogs.” SHAs: `cd7cad4e` introduces `models-store.ts`, `remote-catalog-provider.ts`, Radius merge; `fab309e9`, `bd9e09db`, `97f9978f` refine. Upstream: locked JSON store, 4-hour throttle, provider-ID-keyed parsing, 404/501 unavailable overlay, versioned UA. I/C have none. Class: **PORT/CONFLICT**. Action: use Magenta config dir, lock semantics, offline flag, and user agent; migration must read legacy auth catalog without overwriting external auth. Tests upstream `models-store`, `remote-catalog-provider`, `radius` plus corrupt store, concurrent process, `.magenta` path.

**CC-053 - extension refreshModels and legacy modifyModels**

Version/official: 0.80.8, “Added extension provider `refreshModels(context)`…”, while legacy OAuth `modifyModels` remains a synchronous compatibility projection after credential initialization. SHAs: `bd9e09db`, `9993c969`. Upstream: `ProviderConfigInput.refreshModels`, composer validates before publishing, optional `context.store`, abort-safe refresh; `model-runtime-modify-models-compat.test.ts`. C only has `modifyModels`. Class: **CONFLICT**. Action: add async hook to extension types/runner and ensure HCP reload waits; no network refresh under offline mode; keep legacy callback until extension migration. Tests abort, persistence opt-in, invalid result does not publish, credential projection timing.

**CC-054 - live selector refresh**

Version/official: 0.80.8, “Changed `/model` to render the current model snapshot immediately, refresh configured providers in the background, and update the open selector with partial results or timeout errors.” SHA: `fab309e9`. Upstream core: runtime/catalog refresh; selector UI outside scope; remote catalog tests and scoped-order regression. C model selector uses custom registry/Ultra scope. Class: **CONFLICT**. Action: expose snapshot + refresh events from ModelRuntime, then update UI owner without blocking. Preserve current scoped order and search. Tests immediate open, partial provider, timeout, close-before-result.

**CC-055 - `pi update --models`**

Version/official: 0.80.8, “Added `pi update --models` to force an immediate model catalog refresh without updating pi or extensions.” SHA: `97f9978f`. Upstream: package command path calls forced catalog refresh; docs/tests. C update/package command is heavily customized and binary is `magenta`. Class: **CONFLICT/PORT**. Action: add `magenta update --models` routed to runtime `refresh({force/allowNetwork})`; ensure it does not invoke package/GitHub acquisition or self-update. Tests command isolation and offline error.

**CC-056 - xAI device OAuth/Grok 4.5**

Version/official: 0.80.8, “Added inherited xAI device-code OAuth login and Grok 4.5 OpenAI Responses support…”. Dependency SHA: `5220aba6` (pi-ai plus UI). No owned core implementation beyond consuming provider-owned auth. C lacks provider-owned runtime. Class: **DEPENDENCY**. Action: upgrade pi-ai/provider catalogs with CC-049; test device interaction callbacks and thinking levels.

**CC-057 - Bun binary OAuth resources**

Version/official: 0.80.8, “Fixed Bun standalone binaries to bundle OAuth adapters for interactive logins.” SHA: `6442536b` (Bun entry/build outside scoped core, package resource consequence). C's package scripts bundle HCP assets and build multiple Magenta binaries. Class: **CONFLICT(package/resources)**. Action: include provider OAuth modules as Bun static imports/entrypoints without replacing C's `copy-binary-assets`; verify HCP `skills/sandbox/tools/policy/runtime`, wasm, docs/examples, and release marker remain. Test compiled binary `/login` for OAuth provider and resource marker.

**CC-058 - catalog refresh hardening**

Version/official: 0.80.8, “Fixed configured-provider catalog refresh to parse pi.dev's model-ID keyed responses, throttle checks to once per four hours, send the versioned pi user agent, treat unimplemented routes as unavailable overlays, and show concise refresh status.” SHAs: `fab309e9`, `bd9e09db`, `97f9978f`; dependency `2be9efa1` publishes catalogs. Upstream: `remote-catalog-provider.ts`, `models-store.ts`. C has no equivalent. Class: **PORT**. Action/tests: covered by CC-052/054/055; additionally preserve Magenta branded UA/version and avoid leaking credentials to catalog host.

**CC-059 - removed redundant runtime projections**

Version/official: 0.80.8 breaking, “Removed redundant `ModelRuntime.getAll()`, `find()`, `getSnapshot()`, and `getAuthOptions()`; use Models `getModels/getModel/getProviders/checkAuth`.” SHA: `9993c969`. C call sites use `ModelRegistry.getAll/find/getApiKeyAndHeaders`. Class: **CONFLICT/API migration**. Action: do not recreate removed methods on ModelRuntime; confine legacy projections to an extension compatibility wrapper and migrate Magenta core to Models methods. Test no core imports the wrapper after migration.

## 7. Dependency-only changelog audit (relevant to core behavior)

The following 0.80.3-.8 official items do not have an owned coding-core implementation but must be included in the dependency upgrade/test plan because core relies on them:

- 0.80.4 exported `InMemorySessionStorage`/`JsonlSessionStorage` (`cb222bf9`) and custom JSONL header metadata (`7198e78f`) live in pi-agent. C has its own session/teammate headers; reconcile types before exposing these exports.
- 0.80.4 inherited long-context/caching/provider fixes (including `8973ae28` stale post-compaction usage, `9eedaf8c` Copilot 1M context) affect C's compaction thresholds and model selector once pi-ai/agent are upgraded.
- 0.80.7 ambient Bedrock/Cloudflare auth fixes (`19fe0e01`, `850c210b`) are prerequisites for CC-043/049; do not emulate them in coding-agent.
- 0.80.7 toolChoice and message-anchored encoding live in pi-ai/agent; CC-041 only supplies coding-agent activation metadata.
- 0.80.8 Codex 64-character session IDs (`dcfe36c7`), tab normalization (`1c799cec`), Windows title (`12545274`/`c6d83715`), and adjacent-thinking rendering (`45203abf`) are dependency/UI changes. C's deterministic collaboration IDs must still be tested through Codex after upgrade.
- 0.80.8 xAI and Bun OAuth are CC-056/057; their provider/UI source is outside owned core.

Other inherited model metadata/pricing/provider transport entries have no coding-core symbol beyond the pi-ai dependency and generated catalog. They should be validated by the ai-package owner, not copied into this scope.

## 8. Recommended migration sequence

1. **Dependency floor and contract tests:** upgrade pi-ai/pi-agent/TUI to a coherent U8-compatible set in an isolated branch. Freeze current Magenta tests for external auth, default tools, HCP package resources, Ultra, compaction, peer/background activation, and binary resources.
2. **Credential adapter before runtime:** implement a pi-ai `CredentialStore` adapter for Magenta stored auth plus external source resolution. Make precedence and external-file non-ownership explicit. This is the gate for CC-048..050.
3. **Introduce ModelRuntime without deleting compatibility:** bring `model-config`, `provider-composer`, `runtime-credentials`, ModelRuntime, store/catalog files; add deprecated adapters for existing internal call sites. Migrate core stream/auth paths, then extension-facing wrapper.
4. **Dynamic refresh and login:** add provider-owned login/logout/status, `refreshModels`, store persistence, picker background refresh, and `update --models`. Only then remove registry-owned OAuth registrations.
5. **Session/compaction owner fixes:** apply CC-005/007 at session orchestration boundaries and CC-017/034/039/043 in `@magenta/harness` or the Models adapter. Avoid restoring duplicated upstream compaction logic.
6. **Extension lifecycle and tools:** add session-info/settled/header/entry-renderer contracts, then message-anchored `addedToolNames`. Integrate with HCP/package/MCP/native tools and external activation.
7. **Low-risk settings/tool fixes:** BMP, editor/output padding, bash/edit validation, shell tilde, retry/undici guards, RPC export.
8. **Public/binary cleanup:** switch SDK exports, add `rpc-entry`, bundle OAuth, preserve Magenta/HCP assets, update version and docs only after API compatibility tests pass.

### Go/no-go gates

- No ModelRuntime merge until external Claude/Codex/env/stored credential precedence tests pass.
- No compaction merge until the behavior is proven in the harness owner and peer/bg hidden entries are excluded correctly.
- No dynamic-tool merge until the current default set (`read,bash,edit,write,bg_shell,sub_agent,send_message,show,grep,find,ls`, plus capability/HCP/package/MCP tools) and `noTools` filters remain unchanged.
- No package.json replacement: edits must be field-level and binary smoke tests must verify HCP resources.

## 9. Proposed focused test matrix

- **Auth/runtime:** custom in-memory CredentialStore; locked OAuth refresh; stored vs external vs env vs runtime precedence; Claude Code base URL; Codex API-key/custom provider; Codex OAuth; ambient AWS/Cloudflare; header casing/deletion; one auth resolution per request; logout external non-destruction.
- **Catalogs:** corrupt/empty/legacy store; concurrent writers; offline startup; 404/501; four-hour throttle; force refresh; keyed response; partial provider; aborted refresh; extension persistence opt-in.
- **Session/compaction:** invalid explicit file preservation; no-session ID; pre-prompt stop; serialized split summaries; custom visible/hidden budget; stale usage boundary; ambient branch summary; new-session label cache.
- **Extensions:** session_info_changed; agent_settled ordering and exactly-once; async header hook/error; entry renderer resume/context exclusion; named inline cache; refreshModels abort/validation.
- **Tools/resources:** additive anchored activation from extension/package/HCP/MCP; removal fallback; explicit allow/deny/noTools; BMP local/SSH; bash timeout boundaries/auto-promotion; edit unknown fields; project/global trust and precedence.
- **Packaging:** root SDK type imports; `./rpc-entry`; Bun OAuth login; Magenta binary name; HCP resources and release marker; wasm/assets/docs/examples.

## 10. Scoped commit coverage appendix (70/70 mapped)

Every commit returned by the tag-bounded scoped Git log is mapped below, including releases, merges, reverts, and mechanical items.

| Commit | Mapping | Note |
|---|---|---|
| `63386614` | CC-001 | benchmark print ordering |
| `371adcf3` | CC-002 | explicit provider retry |
| `0bdbe7c5` | CC-001 | extension timings |
| `d8a2cab3` | CC-001 | drain terminal replies |
| `4cc339f5` | CC-003 | BMP disk reads |
| `e454f50b` | CC-004 | no-session ID |
| `543710f6` | CC-005 | reject invalid file |
| `77428858` | CC-006 | default OpenAI model |
| `0d145e89` | CC-005 | error text shortening |
| `73581ea9` | CC-007 | pre-prompt stop |
| `7ba1b6bf` | CC-008 | RPC commands/root export |
| `122527b2` | CC-008 | rpc-entry package/Bun support |
| `87ad8243` | NO-OP/outside | experimental orchestrator touched root export; Magenta has its own orchestrator, do not import |
| `5a073885` | CC-009 | external editor |
| `234c2ad5` | CC-008 | PR merge |
| `a8c692c7` | CC-007 | PR merge |
| `726a9c52` | CC-010 | session event |
| `2117b61c` | CC-013 | undici guard |
| `6564d947` | CC-011 | output padding |
| `9be55bc7` | CC-011 | user padding follow-up |
| `e547bb9f` | CC-012 | state refresh |
| `fd6659dd` | CC-012 | preserve run prompt |
| `a23abe4a` | NO-OP/release | version 0.80.3 |
| `cbcf4e04` | CC-014 | upper timeout bound |
| `85b7c247` | CC-014 | positive timeout |
| `040f0a51` | CC-015 | model helper exports |
| `ba10b60b` | CC-016 | entry renderers/order |
| `f58c1156` | CC-017 | sequential compaction |
| `f8bec25f` | CC-018 | persistence errors |
| `67575615` | NO-OP/reverted | context hook abort, reverted by `2b00dade` |
| `ca09b2b1` | CC-019 | auth-aware default |
| `83cbfc65` | CC-020 | Vercel attribution removal |
| `a1b336d7` | CC-021 | edit extra fields |
| `035ea9c8` | CC-022 | mechanical keybinding guard |
| `6efc09b7` | CC-023 | label cache |
| `8c0ccd14` | CC-024 | null content |
| `c8ada4e7` | CC-025 | project config resources |
| `b3dff19a` | CC-026 | InlineExtension |
| `244f1dea` | CC-027 | provider headers hook |
| `2b00dade` | NO-OP/revert | cancels `67575615` |
| `312bc713` | CC-028 | provider login argument |
| `c6251a86` | CC-029 | overrides on extension models |
| `2170363a` | CC-030 | Windows traversal |
| `c4281a7d` | CC-031 | session warning |
| `1ffca0f2` | CC-032 | reload descriptions |
| `e9fa5a68` | CC-033 | agent settled |
| `a6f720e6` | CC-034 | compaction custom messages |
| `3f9aa5d1` | CC-035 | cache miss notices |
| `912d0953` | NO-OP/release | version 0.80.4 |
| `cc62baa4` | NO-OP/release | empty 0.80.5 release |
| `fbdd4638` | CC-036 | max thinking |
| `a9ecf301` | CC-037 | price tiers |
| `1a2542b1` | CC-038 | shell tilde |
| `2b3fda99` | NO-OP/release | version 0.80.6 |
| `3b686ac2` | CC-040 | copy shortcut |
| `d7a48d30` | CC-040 | text paste fallback |
| `3d8f7435` | CC-041 | anchored tools |
| `298665cf` | CC-042 | affinity format |
| `7303cbac` | CC-043 | ambient summary auth |
| `b084d2fb` | CC-044 | npm peer-dep removal |
| `961fa6c1` | CC-045 | Radius precursor |
| `f4e9ca74` | CC-046 | remove date |
| `9993c969` | CC-048/049/050/051/053/059 | ModelRuntime main change |
| `818d6745` | NO-OP/release | version 0.80.7 |
| `cd7cad4e` | CC-048/051/052 | merge/conflict resolution, introduces stores/catalog files |
| `fab309e9` | CC-052/054/058 | picker/catalog refresh |
| `bd9e09db` | CC-052/053/058 | dynamic provider refresh |
| `5e336cfa` | CC-048 | mechanical merge; scoped effective change is package dependency/version reconciliation |
| `97f9978f` | CC-052/055/058 | force model refresh flag |
| `fae7176c` | NO-OP/release | version 0.80.8 |

### Coverage conclusion

- Scoped log commits mapped: **70/70**.
- Scoped new U8 core files absent from C: **8/8** (`cache-stats`, `model-config`, `model-runtime`, `models-store`, `provider-composer`, `radius`, `remote-catalog-provider`, `runtime-credentials`).
- CC records: **59** (including one mechanical record and dependency-only records).
- Highest-risk records: **CC-048, CC-049, CC-050, CC-051**; they must be implemented as one coherent runtime/auth migration, not independently cherry-picked.
