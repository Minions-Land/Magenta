# Contract — HCP Unification (Phases 0–6) — v2 (post-adversarial-review)

## Objective

Route ALL non-LLM harness/packages content through the single chain:

    LLM → HcpClient → HcpServer → HcpMagnet → harness source

Everything in `harness/` and `packages/` that is NOT LLM-facing must be
**assembled into one HcpClient** at session setup and **resolved from that
HcpClient** by pi — never via a consumption-path `import { X } from
"@magenta/harness"` of the impl, never via a second selection registry.

External behavior must be **byte-identical**. HCP is setup-only; the runtime hot
path stays `tool.execute()` / `provider.method()` direct-call.

## Verified ground truth (read from code, not assumed)

- pi ALREADY assembles an HCP: `DefaultResourceLoader` calls
  `assemblePackageToolMagnets` and stores `assembly.hcp` (resource-loader.ts
  ~L931), exposed via `getPackageHcp()` (~L491). BUT `AgentSession` never reads
  it (grep: 0 hits) → the HCP is **orphaned**. Compaction is a direct import
  (agent-session.ts L61 `from "./compaction/index.ts"`).
- `getPackageHcp()` exists on the CLASS but NOT on the `ResourceLoader`
  interface (~L54) → SDK consumers can't reach it without a cast.
- `CAPABILITY_KINDS` (package-overlay.ts ~L400) = 8 kinds: compaction, context,
  hook, memory, policy, prompt-template, runtime, sandbox. It does NOT include
  `system-prompt` or `multiagent`, even though both have magnets in
  `CAPABILITY_SOURCE_MAGNETS` (sources.ts, 10 magnets). Only kinds in this set
  are assembled by `assemblePackageToolMagnets`.
- system-prompt today loads via overlay `resources.systemPromptPaths` (file
  paths), NOT via `resolveCapability` → it is a RESOURCE, not a capability.
- pi's `compact()`/`prepareCompaction()` already satisfy the harness
  `CompactionProvider` contract (compaction/contract.ts); `piCompactionProvider`
  (compaction/pi/provider.ts) re-exports exactly these → C1 is a wiring change,
  not a logic rewrite.
- pi built-in tool files (`core/tools/<t>.ts`) already import the logic layer
  (`createXExecute`, `<x>Schema`, descriptions) from `@magenta/harness`; the pi
  file only adds TUI render + operations injection. Duplication is at the
  WRAPPER level, not the logic level.
- Default active tools (sdk.ts ~L258): read, bash, edit, write, bg_shell,
  sub_agent, + trunk + package + userMcp. bg_shell & sub_agent are pi-local
  controllers, NOT harness tools.
- packagesRoot mismatch: agent-harness.ts L195 uses `packagesRoot: cwd`;
  overlay uses `resolve(repoRoot, "packages")`. Must align in the unified path.

## Invariants

- INV-1 (chain integrity, per-capability post-migration): once a capability is
  migrated in its phase, it has ZERO consumption-path `import` of the impl in
  pi; it is reached only via `hcp.resolveCapability(name)` or
  `hcp.resolve("tool:"+name)`, whose target's magnet `build()`/`createExecute()`
  returns the harness source. Pre-migration capabilities may still import
  directly. Full INV-1 holds after Phase 5.
- INV-2 (one registry): exactly one HcpClient per session drives consumption.
  `sources.ts` stays a dumb barrel (no selection logic). No second selection
  table introduced.
- INV-3 (hot path off HCP): HCP used only at assembly; runtime calls stay
  direct. No RPC/serialization added. Verify: no `hcp.` call inside
  tool.execute or the per-turn loop body.
- INV-4 (magnet one-of): each magnet yields at most one of tool/capability/
  resource (already enforced in assemblePackageToolMagnets; keep the guard).
- INV-5 (behavior parity) — verified by concrete sub-assertions:
  - INV-5.1: for each t in [read,bash,edit,write,find,grep,ls],
    `JSON.stringify(hcpTool.parameters)` == pre-migration bytes.
  - INV-5.2: `buildSystemPrompt(opts)` string identical for same opts.
  - INV-5.3: `shouldCompact(tokens,window,settings)` identical boolean.
  - INV-5.4: default-active-tool-names array unchanged.
  - INV-5.5: `tool.execute(input)` returns same ToolResult content shape for
    fixed inputs (golden test per tool).
- INV-6 (no dead second runtime): after Phase 6, one assembly path;
  `agent-harness.ts` (Runtime A) deleted OR demoted to a clearly-labeled SDK
  example, and its `packagesRoot: cwd` bug removed.

## Completion assertions (each PASS/FAIL/UNCLEAR)

### C0 — unified assembler (no consumer change)
- C0.1: a single function `buildSessionHcp({ repoRoot, packagesRoot, overlay?,
  includeBuiltInTools })` exists that returns one HcpClient registering BOTH
  built-in tool magnets AND all capability slots. `packagesRoot` defaults to
  `resolve(repoRoot,"packages")`.
- C0.2: a test resolves every expected address from it:
  tools `tool:{read,bash,edit,write,find,grep,ls}`; capabilities
  `capability:{compaction,context,hook,memory,policy,prompt-template,runtime,
  sandbox}`. Each returns a defined instance/AgentTool.
- C0.3: zero consumer files changed; full build + both test suites green.
- C0.4: decision recorded for system-prompt & multiagent: system-prompt stays a
  RESOURCE (overlay resources path), multiagent stays sub_agent-only import;
  neither is added to CAPABILITY_KINDS in C0. (Revisit in C3.)

### C1 — compaction via HCP
- C1.1: `ResourceLoader` INTERFACE gains `getPackageHcp(): HcpClient | undefined`
  (null-loader returns undefined).
- C1.2: `AgentSession` obtains the session HcpClient and replaces the direct
  `compact`/`shouldCompact`/`prepareCompaction` import usage with
  `hcp.resolveCapability<CompactionProvider>("compaction")`.
- C1.3: compaction still triggers on the same threshold and produces identical
  output (INV-5.3 + golden compaction test).
- C1.4: no consumption-path compaction import remains in agent-session.ts.

### C2 — built-in tools via tool magnets
- C2.1: the 7 file/shell tools route through `buildSessionHcp` tool magnets
  using the SAME harness `createXExecute`+schema the pi wrappers already import.
- C2.2: pi render layer stays as a name-keyed decoration applied AFTER resolving
  the AgentTool (renderer-registry keys by tool name). TUI output unchanged.
- C2.3: bg_shell & sub_agent remain pi-local; excluded from HCP tool assembly.
- C2.4: options injection (SSH ops, shellPath, commandPrefix, autoResize) is
  threaded through the magnet spec; tool behavior unchanged.
- C2.5: INV-5.1 schema-bytes parity holds for all 7 tools.
- C2.6: duplicate wrapper logic collapsed — pi tool files contain render+options
  only, zero re-implemented execute logic.

### C3 — resources: context / system-prompt / prompt-templates / skills
- C3.1: prompt-templates + skills continue to resolve (already via
  resourceLoader); context resolves via `resolveCapability("context")`.
- C3.2: system-prompt EITHER (a) added to CAPABILITY_KINDS and routed via HCP,
  OR (b) explicitly kept as overlay RESOURCE — decision recorded with rationale.
  Chosen path must keep INV-5.2 byte-identical.
- C3.3: system-prompt output byte-identical (INV-5.2).

### C4 — hooks
- C4.1: define `HookProvider` contract; `ExtensionRunner` accepts optional
  `hcp` and delegates hook emission to `hcp.resolveCapability("hook")` when
  present, else uses its internal bus (backward compat).
- C4.2: extension + TUI hooks fire identically (golden hook-order test).
- C4.3: one hook path — no duplicated dispatch.

### C5 — policy / sandbox / runtime (command execution)
- C5.1: bash/command execution resolves runtime+sandbox+policy from HCP.
- C5.2: DEFAULT behavior = current (portable guards only, no new prompts/
  denials). Extra guards opt-in only.
- C5.3: no new user-visible approval prompts by default (parity test).

### C6 — menu + cleanup
- C6.1: `/dock` Harness menu is a view over the single session HcpClient
  (`describeAll()`); switches map to HCP enable/disable ops.
- C6.2: Registry/Catalog inspection views separated from live module toggles.
- C6.3: Runtime A (agent-harness.ts) deleted or demoted; duplicate tool wrapper
  logic removed; build + tests green.

## Non-goals
- Not merging the two loops (both already use pi-agent-core runAgentLoop; keep
  pi's Agent).
- Not adding transport/RPC to HCP.
- Not changing LLM providers/streaming/auth/thinking/model-registry.

## Grading axes (per phase): Correctness · Coverage · Rigor · Format-parity.
