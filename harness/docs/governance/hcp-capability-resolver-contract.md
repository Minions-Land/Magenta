# HCP as the Single Capability Resolver — Design Contract

> **SUPERSEDED (2026-07-03) by [`hcp-architecture.md`](./hcp-architecture.md).**
> That document is now authoritative. It carries forward the resolver model and
> invariants below, and updates them with: the three-role naming
> (`HcpClient`/`HcpServer`/`HcpMagnet`, retiring `HcpTarget`/`HcpRegistry`),
> HCP-as-a-protocol-standard with pluggable transport, the transport split
> (Tool/Resource/Prompt over the wire; Capability in-process), the added
> Resource primitive, and Magnet relocation into source folders. Where the two
> disagree, `hcp-architecture.md` wins. This file is kept for history.

Date: 2026-07-03
Role: Planner. This document is the binding contract for tasks #15–#19 (pilot
rework) and #13 (rollout). Generators and Evaluators must conform to it.

## Problem this fixes

The assembly layer had three defects that violated the intended HCP/Magnet model:

- **P1 — HCP bypassed at assembly.** `registerMagnetHcpTargets` was never called
  in non-test code. `assemblePackageToolMagnets` pushed bare `magnet.toTool()` /
  `magnet.toCapability()` products straight to consumers; the one `HcpRegistry`
  did not participate in assembly at all.
- **P2 — a second registry.** The compaction pilot added
  `registerCapabilityFactory(kind, source)` — a parallel global registry beside
  HCP. This violates "there is only one HCP".
- **P3 — source hardcoded in the consumer.** The loop consumed compaction via
  `this.resources.compaction ?? piCompactionProvider`, naming the `pi` source in
  consumer code. Consumers must never name a source.

## The model (user ruling)

HCP is the ONE **capability resolver**. A consumer — including the LLM's view of
tools — only asks for a capability by name ("compaction", "memory", "bash"). HCP
resolves that name to the **selected source's typed instance** and hands it back.
Which source (pi / magenta / codex / claude-code / …) is chosen by TOML/package
selection, never by the consumer.

- **Magnet is a two-headed abstraction.** One head attaches to HCP; the other
  attaches to a concrete Source implementation. Source-side interfaces may differ
  per source and per language (Rust, TypeScript, Python, …) and are NOT forced to
  unify. Magnets are per-object abstractions: a Tool-Magnet, a Memory-Magnet, a
  Compaction-Magnet, etc. The concrete implementation template for each is
  dictated by that Source's characteristics.
- **HCP is a single-layer abstraction.** We may add interfaces on it freely, as
  long as the resolver effect holds. It is like MCP but one level more abstract:
  it manages any capability regardless of the source's language or runtime, not
  just tools/resources/prompts over a fixed transport.
- **Reconciliation with the READMEs.** The READMEs say "HCP is only used at setup;
  at runtime the loop calls tools directly." That remains true: *selection /
  resolution* happens at and through HCP; the *resolved typed instance* is then
  called directly on the runtime hot path. HCP stays off the hot path and stays
  invisible to the LLM. Both statements hold simultaneously.

## Concept vocabulary

This vocabulary is part of the contract. Later rollout work should use these
terms consistently instead of inventing parallel names.

- **API** means a stable interaction boundary between modules. It is not
  necessarily HTTP. An API defines what can be called, the input and output
  shapes, ownership, lifecycle, errors, and whether it is on the runtime hot
  path. HCP API, AgentTool API, and Pi UI/session APIs are different layers.
- **Source** means the implementation origin or ownership family, such as
  `pi`, `magenta`, `codex`, or `claude-code`. It is not a programming language
  or transport category. Consumers do not read Source names.
- **Capability** means an assemblable ability. A Capability may be model-visible
  or invisible to the model: tools, memory, compaction, policy, runtime, hooks,
  workspace backends, model providers, and similar modules are all capabilities.
- **Tool** is the model-visible subtype of Capability. It has the familiar
  `name`, `description`, `parameters`, and `execute()` shape. The agent loop
  executes `tool.execute(...)` directly; it does not wrap each call in
  `hcp.dispatch(...)`.
- **HCP** is the Harness Component Protocol: the control-plane API for discovery,
  description, configuration, enable/disable, health, lifecycle, and resolving a
  final typed instance. HCP finds, manages, and hands off; it does not perform
  every runtime call.
- **Magnet** is the adapter layer. One head connects to HCP; the other connects
  to a concrete Source implementation. Source implementations may have different
  native APIs, languages, and runtimes; the Magnet absorbs that difference and
  presents the uniform Tool / Capability / HCP target shape.
- **Registry / package overlay** is declaration and discovery: it reads component
  descriptors (`kind`, `name`, `source`, and compatibility metadata), selects the
  Source, constructs the Magnet, and registers the result into the one HCP.
- **Runtime** is where the resolved instance actually runs. After HCP resolves a
  Tool or Capability, Pi or the agent runtime calls the returned in-process
  instance directly.
- **Pi** owns the agent loop, TUI, session state, slash commands, and user
  experience. UI/session features such as Side Chat belong here unless they
  expose a reusable backend capability.
- **Harness** owns reusable capabilities and the assembly system: HCP, Magnet,
  registry/package overlay, and source-selectable implementations.

In short:

```
Source implementation -> Magnet adapter -> HCP management/resolution
                     -> resolved AgentTool/Capability instance -> direct runtime call
```

### Examples

**todo** is a Tool Capability. The descriptor says `kind = "tool"`,
`name = "todo"`, and a selected Source. The Tool Magnet adapts that Source's
implementation into an `AgentTool`; HCP can describe and manage it; the loop
ultimately calls `todo.execute(...)`.

**memory** is a non-tool Capability. `memory:magenta` may be a session-grounding
fact store while `memory:pi` may be a vector store. Their native APIs can differ;
their Magnets adapt each Source to the shared memory capability contract. The
consumer asks HCP for `memory` and never learns which Source was selected.

**ssh** should be treated as a workspace/backend capability, not as a new
model-visible "ssh" tool by default. The user experience can be `pi --ssh
user@host:/repo`, while the model still calls normal `read`, `write`, `edit`,
and `bash` tools whose underlying workspace operations are backed by SSH.

**Side Chat** is Pi app experience, not a Harness capability by default. It
depends on TUI overlay state, input focus, current session, model choice,
streaming display, and slash-command ergonomics. Those are Pi runtime/UI APIs,
not reusable Harness execution capabilities.

## Design posture

This architecture is a later-comer advantage: Magenta can learn from Pi, MCP,
Claude Code, Codex, and other agent systems without inheriting their exact
boundaries. The point is not to add another abstraction for the LLM to reason
about. The point is to keep the model-facing surface simple while Magenta owns a
stronger assembly/control layer behind it:

**HCP is the control plane, Magnet is the adapter layer, Source is the
implementation origin, Capability is the assembled ability, and the agent runtime
directly calls the final resolved instance.**

## Invariants (must not be broken)

Inherited from `contract.md`, plus this contract:

1. **Exactly one HCP.** One `HcpRegistry` type; no parallel capability/factory
   registry anywhere. Selection is a responsibility OF that registry.
2. **Every module has one Magnet**, which converges every source/runtime into the
   Magnet contract before reaching the loop (existing invariant).
3. **HCP is not the execution hot path.** Resolution goes through HCP; the
   returned instance is invoked directly. No call is wrapped into an HCP message
   on the hot path.
4. **Consumers are source-agnostic.** No consumer code (loop, session, …) names a
   source or falls back to a source-specific import.
5. **pi is not deep-rewired this phase.** `assemblePackageToolMagnets` keeps a
   backward-compatible return shape so `pi/coding-agent/src/core/resource-loader.ts`
   (line ~822, uses `assembly.tools`) compiles unchanged.
6. **HCP/Magnet are not themselves selectable runtime components** (governance
   Non-Goal). We add resolution to HCP; we do not make HCP a swappable module.

## Interface changes (the "add interfaces on HCP" allowance)

### HcpTarget gains an optional typed accessor

```ts
interface HcpTarget {
  describe(): HcpTargetDescription;      // unchanged
  call(call: HcpCall): Promise<unknown> | unknown;  // unchanged (management)
  /** Assembly-time: the selected source's typed implementation for this slot,
   *  if this target backs an in-process capability. Absent for pure management
   *  / inspect-only targets. */
  instance?<T = unknown>(): T;
}
```

Rationale: `call()` returns `unknown` and is the management channel. Forcing every
capability consumption through `call({op:"instance"})` would erase types and
contradict HCP's own "never wrap an actual call as an HCP message" note. A typed
`instance()` accessor is the clean, source-invisible handoff the user asked for.

### HcpRegistry gains name-based capability resolution

```ts
class HcpRegistry {
  // ... existing register / registerExact / resolve / dispatch / describeAll ...
  /** Resolve a capability by its slot name (e.g. "compaction") to the selected
   *  source's typed instance. Looks up the target for that capability address,
   *  then returns target.instance<T>(). Returns undefined if no target is
   *  registered for the name or the target exposes no instance. */
  resolveCapability<T>(name: string): T | undefined;
}
```

Address convention: a capability slot named `compaction` registers under target
address `capability:compaction` (or is reachable by the bare name). `resolveCapability`
encapsulates the address convention so consumers pass only the slot name.

### Magnet.toCapability + toHcpTarget cooperate

A capability Magnet's `toHcpTarget()` MUST return a target whose `instance<T>()`
yields the same selected-source implementation that `toCapability().instance`
holds. The binding's `source` is metadata for management/inspection only — it is
NOT consulted by consumers.

## Assembly flow (the corrected data path)

```
capability slot  ──selection(TOML/package)──▶  Magnet(source impl on one head)
      │                                              │ toHcpTarget()
      ▼                                              ▼
  registerMagnetHcpTargets(hcp, magnets)  ──▶  the one HcpRegistry
      │                                              │
      │ tools: hcp.resolve(tool addr).instance()     │ resolveCapability<T>(name)
      ▼                                              ▼
  assembly.tools (AgentTool[])            consumer gets typed instance, calls directly
```

`assemblePackageToolMagnets` after building all magnets:
1. Create one `HcpRegistry`.
2. `registerMagnetHcpTargets(hcp, magnets)` — tools and capabilities alike.
3. Derive `tools` by resolving each tool target's instance (still an `AgentTool`,
   invoked directly at runtime — hot path unaffected).
4. Derive `capabilities` map from `resolveCapability`.
5. Return `{ magnets, tools, capabilities, hcp, diagnostics }` — existing fields
   keep their shape; `hcp` is additive. resource-loader stays untouched.

## Rollout order (task #13, after pilot #14–#19 is accepted)

Topological, sharing-serialized on `index.ts` / `package-overlay.ts`:
memory (activate pi + magenta halves to PROVE switchability) → context →
system-prompt → prompt-templates → env → session → policy → hooks → sandbox →
runtime → loop. Tools folded into HCP resolution in the same pass.

## Success gates (Evaluator, #19 and each rollout step)

- Consumption chain shows no source hardcoded anywhere (grep the consumer for
  source names → none).
- Flipping the selected `source` in TOML changes the instance HCP resolves
  (switchability proven by test, not asserted).
- Full harness suite green (≥197 tests, no regression); `harness npm run build`
  green; `pi/coding-agent npm run build` green (no deep rewire needed).
- `contract.md` invariants intact: one HCP, Magnet sole boundary, HCP off hot
  path, HCP/Magnet not selectable.
