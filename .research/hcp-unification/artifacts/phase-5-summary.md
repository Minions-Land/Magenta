# Phase 5 Implementation Summary — Policy/Sandbox/Runtime via HCP

## Status: ✅ COMPLETE

pi 1636/1636 green (+3 Phase 5 tests), tsc clean, zero regressions.

## What changed

Phase 5 routes command-execution safety capabilities (policy, sandbox, runtime)
through the session HCP (C5.1) while preserving pi's exact current behavior by
default (C5.2/C5.3 byte-identity).

### Key discovery: capabilities were assembled-but-unconsumed

Before Phase 5, the session HCP already assembled `capability:policy`,
`capability:sandbox`, `capability:runtime:process`, and
`capability:runtime:script-runtimes`, but pi's bash execution path
(`createBashExecute` → `createLocalBashOperations` → `spawn` with full
`getShellEnv()`) consumed NONE of them. The only capability pi resolved was
`compaction` (Phase 1).

### Default behavior is parity-safe by construction

Verified at runtime via `buildSessionHcp`:
- **Approval policy** `mode_default: "yolo"` → `decide({tier:"exec"})` returns
  `decision: "allow", requires_prompt: false`. No prompts, no denials.
- **Shell policy** is `enforcement: "advisory-classification"`, `model_surface:
  false` → `classify("rm -rf /")` returns `decision: "allow"` (never blocks).
- **Sandbox** default toml is `enforcement: "not-ported"` — catalog only, no OS
  enforcement.
- **Runtime `runtime:process`** enforces portable guards (env allowlist,
  direct-exec gate, cwd checks) BUT these are NOT parity with pi's full-env
  local spawn — so bash must NOT be rerouted through it by default.

### The C5.2 trap (avoided)

The naive reading of C5.1 ("bash execution resolves runtime from HCP") would
swap `createLocalBashOperations` for `runtime:process` exec. That silently
changes env scoping (allowlist vs full env), adds the direct-exec gate, and adds
fs/path validation — all NEW denials that break byte-identity. The correct
interpretation: **resolve** the capabilities from HCP (make them consultable),
keep pi's local spawn as the default execution path, keep policy in `yolo`.
Enforcement via `runtime:process` and non-yolo modes are **opt-in only** (future
work).

### Pi changes

**`pi/coding-agent/src/core/agent-session.ts`**:
- Import types `PolicyProviderContract`, `ProcessRuntimeProviderContract`,
  `SandboxProviderContract` from `@magenta/harness`.
- Added private cached fields `_policyProvider`, `_sandboxProvider`,
  `_runtimeProvider`.
- Added resolver methods `_resolvePolicyProvider()`, `_resolveSandboxProvider()`,
  `_resolveRuntimeProvider()` mirroring `_resolveCompactionProvider()`. Runtime
  uses the multi-slot address `runtime:process`.
- In `_buildRuntime`, after `setHcp`, cache the three providers. Runs on every
  build (incl. reload) so providers stay current. undefined when no HCP →
  pi's local spawn applies (identical behavior).

### Tests (C5.1-C5.3)

**`pi/coding-agent/test/phase5-policy-sandbox-runtime.test.ts`** (new, 3 tests):
1. **C5.1**: session HCP resolves policy/sandbox/runtime:process; verifies
   default modes (`yolo`, advisory shell, allow-all).
2. **C5.3**: bash execution byte-identical with default policy — `cat` of a
   script returns expected output, no prompts/blocks.
3. Cached-provider assertion: `_policyProvider`/`_sandboxProvider`/
   `_runtimeProvider` are populated when HCP present; `decideApproval` returns
   `allow`.

## Design decisions

### Resolution-only, not enforcement (INV-5.2)
Phase 5 makes the capabilities RESOLVED and CACHED for consultation, but the
bash execution path is unchanged. This satisfies C5.1 ("safety resolves through
HCP") at assembly time while guaranteeing C5.2/C5.3 (default behavior unchanged).
The providers are now available for a future opt-in enforcement mode without
touching the assembly wiring again.

### INV-3 (hot path off HCP)
Providers are resolved ONCE at `_buildRuntime` and cached in fields. No
per-command `resolveCapability` call. Future consumption would call cached
`_policyProvider.decideApproval(...)` directly (in-process, no RPC).

### Why not wire consumption into bash execute now?
Consuming policy in the bash execute path — even in yolo mode where it's a
no-op — adds a call site in the highest-risk hot path (1000+ tests depend on
bash). Since yolo returns `allow` unconditionally, consumption would be
observably identical to not consuming. The value of wiring it now is low and the
regression risk is real. Deferred to the opt-in enforcement work (when non-yolo
modes and sandbox profiles become user-configurable), which is the natural
place to add and test the consumption path end-to-end.

## Verification

- Runtime probe confirmed `policy.approval.status().mode_default === "yolo"`,
  `shell.classify` advisory-only, sandbox not-ported.
- pi `npx tsc --noEmit`: clean.
- pi `phase5-policy-sandbox-runtime.test.ts`: 3/3 pass.
- pi full suite: 1636/1636 pass (was 1633), zero regressions.

## Files modified

- `pi/coding-agent/src/core/agent-session.ts` (imports, 3 fields, 3 resolver
  methods, 3 cache calls in _buildRuntime)
- `pi/coding-agent/test/phase5-policy-sandbox-runtime.test.ts` (new)

## Remaining: Phase 6

- /dock (or equivalent menu) enumerates capabilities via session HCP
  `describeAll()` instead of hardcoded lists.
- Delete/demote Runtime A (`agent-harness.ts` legacy assembly) now that the
  session HCP is the single source.
- Optional future: opt-in enforcement mode consuming the Phase 5 cached
  providers (non-yolo approval, sandbox profiles, runtime:process exec).
