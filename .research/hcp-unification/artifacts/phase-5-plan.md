# Phase 5 Plan — policy / sandbox / runtime via HCP (C5)

Status: PLAN (research-only; no source touched). Author: peer session 019f40c5.
Cross-checked against code on 2026-07-08. Companion to `contract.md` C5 / INV-5.2.

## Objective (from contract C5)

- C5.1: bash/command execution **resolves** runtime + sandbox + policy from the
  session HcpClient.
- C5.2: DEFAULT behavior == current (portable guards only, no new prompts/denials);
  extra guards opt-in only.
- C5.3: no new user-visible approval prompts by default (parity test).

## Verified ground truth (read from code, not assumed)

- `harness/hcp-client/assembly/sources.ts` already registers
  `policyMagentaMagnet` (L38), `runtimeMagentaMagnet` (L40), `sandboxMagentaMagnet`
  (L41) as default capability sources → after `buildSessionHcp` the session HCP
  exposes `capability:policy`, `capability:sandbox`, `capability:runtime:*`.
- pi's bash path does **not** consume any of them today. `harness/modules/tools/bash/pi/bash.ts`
  has ZERO hits for `policy|sandbox|runtime|resolveCapability|hcp` (grep).
- pi wrapper `pi/coding-agent/src/core/tools/bash.ts` imports `createBashExecute`
  + `BashToolOptions` from `@magenta/harness` (L5–10) and builds local operations
  via `createLocalBashOperations` (raw `spawn` with full `getShellEnv()`).
- Only capability pi resolves from HCP today is `compaction`
  (`agent-session.ts:486-487`). policy/sandbox/runtime are assembled-but-unconsumed.
- Policy default is parity-safe by construction: `approvalStatus()` in
  `harness/modules/policy/magenta/approval.ts` → `mode_default: "yolo"`;
  `decideApproval` with no mode → `allow`, `requires_prompt:false`.
- Shell policy is advisory-only (`shell-policy.ts` enforcement =
  `advisory-classification`, `model_surface:false`) — classify never blocks.
- `runtime://process` (`runtime/contract.ts`) enforces portable guards only
  (`os_enforced:false`, `resolved_backend:"none"`), BUT its env allowlist +
  direct-exec gate + fs/path checks are **NOT parity** with pi's full-env spawn.
- Sandbox default (`sandbox.toml`) is `enforcement = "not-ported"` — inert catalog.

## The C5.2 trap (call out explicitly)

The naive reading of C5.1 — swap `createLocalBashOperations` for
`runtime://process` exec — silently changes env scoping (allowlist vs full env),
adds the direct-exec gate, and adds fs/path validation → new denials → breaks
C5.2/C5.3. Correct interpretation: **resolve + consult** the capabilities from
HCP (available, advisory), but keep pi's local spawn as default `operations` and
keep policy in `yolo`. `runtime://process` enforcement and non-yolo modes are
opt-in only.

## Implementation steps

1. **Thread session HCP into bash construction (resolution only).**
   In `pi/coding-agent/src/core/tools/bash.ts` `createBashToolDefinition`/
   `createBashTool`, accept an optional resolved bundle `{ policy, sandbox,
   runtime }` (or the `hcp` handle) via `BashToolOptions`. AgentSession already
   holds the session HCP (`agent-session.ts:2716 getSessionHcp()`); pass the
   resolved capabilities where it constructs the bash tool. This satisfies C5.1
   without changing execution.

2. **Keep local spawn as default operations.** Do NOT replace
   `createLocalBashOperations`. Default `operations` stays pi's local shell with
   `getShellEnv()`. Route through `runtime://process` only behind an explicit
   opt-in (`toolOptions.bash.enforceRuntime` or an active sandbox profile).

3. **Default policy to yolo / advisory.** Call `decideApproval` with no mode (or
   explicit `yolo`) → `allow`, `requires_prompt:false`. If shell classification
   is wired, treat `classifyShellCommand` output as advisory metadata only (log/
   annotate); never convert `prompt`/`block` findings into real prompts/denials
   unless a non-default mode is configured. Guarantees C5.3.

## Files touched (expected)

- `pi/coding-agent/src/core/tools/bash.ts` — add optional resolved-capability
  bundle to options; wire resolution at construction; keep default operations.
- `harness/modules/tools/bash/pi/bash.ts` (or `BashToolOptions` type site) —
  extend options type to carry the resolved bundle. No execution change.
- `pi/coding-agent/src/core/agent-session.ts` — where bash tool is built
  (near L2716), resolve `capability:policy|sandbox|runtime` from the session HCP
  and pass into bash options. Advisory by default.
- NEW test: `harness/test/session-hcp-phase5.test.ts` (or extend
  `session-hcp.test.ts` / `policy.test.ts`).

Zero changes to `agent-harness.ts` here — that is C6.3.

## Risk assessment

- **Risk: LOW.** Purely additive resolution + advisory consult. Default path
  byte-identical to today (local spawn, full env, yolo, no prompts).
- Main hazard is the C5.2 trap above — reroute through runtime exec. Mitigation:
  keep local operations default; make runtime/sandbox enforcement opt-in.
- Secondary: options-type threading must not alter `BashToolOptions` bytes used
  by INV-5.1 schema parity. Keep additions optional & non-schema (they are
  execution options, not tool parameters) — verify `JSON.stringify(parameters)`
  unchanged.

## Verification

- C5.1: test asserts `hcp.resolve("capability:policy")`,
  `capability:sandbox`, `capability:runtime:process`,
  `capability:runtime:script-runtimes` all non-null after `buildSessionHcp`.
- C5.3 parity: default-assembled session → `approvalStatus().mode_default ===
  "yolo"`; `decideApproval({tool})` default → `{allowed:true,
  requires_prompt:false, denied:false}` for read/write/exec; bash via default
  path uses local ops + full shell env; fixed command output byte-identical vs
  pre-Phase-5. Assert no UI approval event emitted by default.
- INV-5.1: `JSON.stringify(bashTool.parameters)` unchanged.
- Build: `bun run build` in `pi/coding-agent` and `harness`; harness vitest
  (baseline 353 green) + pi suite (baseline 1631 green) stay green.
