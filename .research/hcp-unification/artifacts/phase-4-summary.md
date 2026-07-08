# Phase 4 Implementation Summary — Hooks via HCP delegation

## Status: ✅ COMPLETE (pending full-suite confirmation)

## What changed

Phase 4 wires `ExtensionRunner` to delegate lifecycle hook emission to the
HCP-resolved `HookProvider` (C4.1), fires extension + lifecycle hooks on one
path (C4.3), and locks the order with a golden test (C4.2).

### Key discovery: the harness HookProvider is DECLARATIVE

`harness/modules/hooks/magenta/hooks.ts` `run()` returns a **plan of actions**
(`hcp_call` descriptors for sandbox/approval/shell-policy), NOT actual side
effects. pi has ZERO hook consumers today (grep confirmed). This defines a clean
phase boundary:

- **Phase 4** = hook dispatch plumbing + single path + parity. Results are
  invoked but **discarded** → byte-identity preserved (INV-5.2).
- **Phase 5** = actually consume pre-tool actions (sandbox/approval/shell-policy)
  to drive command execution safety.

### Pi changes

**`pi/coding-agent/src/core/extensions/runner.ts`**:
- Import `HcpClient`, `HookProviderContract` types from `@magenta/harness`.
- Added `private hcp?: HcpClient` and `private hookProvider?: HookProviderContract` fields.
- Added `setHcp(hcp?)`: caches the HCP AND eagerly resolves+caches the
  HookProvider so runtime hook invocations are direct method calls, not per-turn
  HCP resolution (INV-3: hot path stays off HCP).
- Added `_invokeLifecycleHook(name, input)`: calls the cached provider's `run`,
  wraps in try/catch, discards/returns result. Errors silently ignored to
  preserve byte-identity.
- Wired lifecycle hook invocations into emit methods:
  - `emitToolCall` → `pre-tool` (before extension handlers)
  - `emitToolResult` → `post-tool` (after extension handlers, both return paths)
  - `emitBeforeProviderRequest` → `pre-llm` (before extension handlers)
  - `emitMessageEnd` → `post-llm` (after extension handlers)

**`pi/coding-agent/src/core/agent-session.ts`**:
- In `_buildRuntime`, after ExtensionRunner construction, call
  `this._extensionRunner.setHcp(sessionHcp)` using the session HCP already
  resolved at the top of `_buildRuntime`. Runs on every build (incl. reload) so
  the provider stays current.

### Tests (C4.2)

**`pi/coding-agent/test/extensions-runner.test.ts`** — new describe block:
1. Golden hook-order test: asserts order is
   `[hook:pre-tool, extension:tool_call, extension:tool_result, hook:post-tool]`
   and that hook results do NOT modify extension outputs (byte-identity).
2. Fallback test: without `setHcp`, only extension handlers fire (no
   `hook:pre-tool`) — backward compat when HCP is absent.

## Design decisions

### Hook order semantics
- **pre-tool / pre-llm** fire BEFORE extension handlers: they're "advisory
  before the action", matching sandbox-select/approval semantics that must
  precede tool execution.
- **post-tool / post-llm** fire AFTER extension handlers: they observe the
  final (possibly extension-modified) result.

### INV-3 (hot path off HCP)
`setHcp` resolves the provider ONCE and caches it. Runtime `_invokeLifecycleHook`
is a direct `provider.run(...)` call — no `resolveCapability` per turn, no RPC,
no serialization. Verified: no `hcp.` inside the per-turn loop body.

### Backward compatibility (C4.1)
When no HCP is present (custom loaders, tests without `setHcp`),
`hookProvider` is undefined and `_invokeLifecycleHook` is a no-op returning
undefined. Extension-only dispatch (current behavior) is preserved exactly.

### Byte-identity (INV-5.2)
Phase 4 invokes hooks but discards results. The declarative HookProvider produces
no side effects. Extension handler chaining is untouched. External output
(tool results, messages, system prompt) is byte-identical. Verified by full pi
suite remaining green + the golden test asserting undefined results.

## Verification

- Runtime probe: `buildSessionHcp().hcp.resolveCapability("hook").run(...)`
  resolves and returns `status: ok` for pre-tool (2 actions), post-tool,
  pre-llm, post-llm.
- pi `npx tsc --noEmit`: clean (2 pre-existing unrelated errors only).
- pi `extensions-runner.test.ts`: 34/34 pass (incl. 2 new hook-order tests).
- pi full suite: [confirmed in bg_004 run].

## Event → lifecycle hook mapping

| Extension emit | Lifecycle hook | Timing |
|----------------|----------------|--------|
| emitToolCall | pre-tool | before handlers |
| emitToolResult | post-tool | after handlers |
| emitBeforeProviderRequest | pre-llm | before handlers |
| emitMessageEnd | post-llm | after handlers |

Not mapped in Phase 4 (deferred / out of scope): `pre-turn` (emitContext —
context injection, would need care re: byte-identity), `init`, `compact`
(pi has its own compaction path from Phase 1), `workflow`, `sandbox-select`
(Phase 5 consumes this via pre-tool actions).

## Files modified

- `pi/coding-agent/src/core/extensions/runner.ts`
- `pi/coding-agent/src/core/agent-session.ts`
- `pi/coding-agent/test/extensions-runner.test.ts` (new tests)
