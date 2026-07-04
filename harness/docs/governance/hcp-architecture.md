# HCP — Unified Architecture & Naming Contract

Date: 2026-07-03
Status: **AUTHORITATIVE.** This is the single source of truth for the HCP
layer. It absorbed and retired the earlier resolver-model draft
(`hcp-capability-resolver-contract.md`, deleted 2026-07-04); the three-role
naming and protocol-standard framing below supersede it. All rollout tasks,
generators, and evaluators conform to THIS document.

This contract is the product of a design conversation that settled four
load-bearing decisions:

1. **Naming** — exactly three role names: `HcpClient`, `HcpServer`, `HcpMagnet`.
2. **HCP is a protocol standard** (JSON-RPC-2.0-style, language-agnostic) with a
   **pluggable transport**, mirroring how MCP separates protocol from transport.
3. **Transport is split by primitive** — Tool / Resource / Prompt go over the
   wire; Capability stays an in-process live object.
4. **Magnet relocates** into each Source folder; the central builder table is
   dissolved.

---

## 1. Why HCP exists (and why it is not just MCP)

MCP has **two** roles: Client (the LLM side) and Server (the tool/data source).
MCP is essentially a **Tool Call** protocol — one Server *is* one source, 1:1,
with no selection.

HCP is a **Harness Call** protocol — broader than a tool call. Its Server is a
**capability slot** (e.g. `memory`) that can bind **many** sources
(`memory:magenta`, `memory:pi`, …). That switchability is the entire point of
this project, and it is exactly why HCP needs **one layer MCP does not**: the
**Magnet**, the per-source binder that attaches one concrete source to a slot
that can hold several.

```
MCP:   Client ───────────────▶ Server(=the one source)
HCP:   HcpClient ─▶ HcpServer(=a capability slot) ─▶ HcpMagnet(=this source) ─▶ source impl / SDK
```

## 2. The three roles — the ONLY three names

These are the sole role names in the HCP layer. Prior names (`HcpTarget`,
`HcpRegistry`, and the like) are retired — see §7 for the migration map.

### HcpClient
Global, single, **abstract**. The LLM/agent side. It is the router: a consumer
(including the loop's view of tools) asks for something **by name** — `"memory"`,
`"bash"`, `"system-prompt"` — and the HcpClient resolves that name to the
selected source's endpoint. The consumer never spells out a source. Today this
is the `HcpRegistry` class; it is renamed `HcpClient`.

### HcpServer
**One per Harness Module** (= one per capability slot such as `memory`,
`compaction`, `sandbox`, or a tool type). Concrete. An HcpServer represents the
slot and holds the set of sources bound to it. It answers `describe` (what this
slot is, which sources it offers) and routes a resolved call to the selected
source's Magnet. Today this is the per-module `HcpTarget`; it is renamed
`HcpServer`. Note the slot a Server represents is not always at module depth —
for tools it sits one level deeper (per tool *type*), see §2.1.

### HcpMagnet
A **thin, last-inch adapter**, one per source, living **inside that source's
folder** (e.g. `memory/magenta/magnet.ts`). It binds one concrete source
implementation (local code, or an SDK, possibly cross-process) up to its
module's HcpServer, and it chooses that source's **transport** (§4). "Thin"
is a requirement: a Magnet contains binding + transport selection, not business
logic. Today this is `Magnet` / `toHcpTarget()`; it is renamed `HcpMagnet`.

> **Why the Magnet is the switch:** the HcpServer is a slot that *can* hold many
> sources. The HcpMagnet is what binds *one specific* source into that slot.
> Selection (TOML/package overlay) picks which Magnet is active. MCP has no
> Magnet because its Server has no choice to make.

### 2.1 Slot depth is NOT uniform — some modules are one level, tools are two

The `Client → Server → Magnet → source` path is fixed, but **how deep the slot
sits is not the same for every module.** This is a load-bearing observation, not
an implementation detail, and it must be recorded at the role level so no reader
assumes "one Harness Module = one flat slot" everywhere.

- **One-level modules (the common case).** `memory`, `compaction`, `sandbox`,
  `runtime`, … a module folder contains sources **directly**
  (`memory/{magenta,pi}/`). The module *is* the slot; it has exactly one
  HcpServer, and the sources hang straight off it. `memory` needs **one**
  HcpServer, full stop.
- **Two-level modules (tools).** `tools/` is not itself a single slot — it is a
  *namespace of slots*. The real slot is the **tool type**
  (`tools/bash/`, `tools/read/`, …), and sources sit under that
  (`tools/bash/{magenta,pi}/`). So the depth is `tools → tool-type → source`,
  one level deeper than a capability.

The consequences of this two-level shape (a per-tool-type HcpServer, whether the
`tools/` layer needs its own grouping node, and where Tool Search belongs) are
resolved in §6. The invariant that survives both shapes: **HcpClient is always
global-single** (never one client per tool), and **every actual slot — one-level
or two-level — has exactly one HcpServer.** The depth changes where the Server
sits, not how many Clients exist.

> **Open question carried from the design conversation.** Whether the `tools/`
> namespace itself warrants a thin intermediate HcpServer (a "tool group"
> router) above the per-tool-type Servers, or whether Tool Search alone covers
> that role, is deliberately left as a decision for §6 / the Tool Search work
> item (§11.6). It is flagged here so the asymmetry is visible from the role
> definitions, not discovered later.

## 3. HCP is a protocol standard, not a hardcoded wiring

HCP is defined as a **message standard** — JSON-RPC-2.0-shaped requests and
responses, **language-agnostic**. Any source that can receive a JSON message,
act, and return a JSON message can be served over HCP, regardless of the
language it is written in (TypeScript, Python, Rust, shell, …). This is the same
posture as MCP: the protocol says *what a message looks like*, not *how it
travels*.

The message envelope (shape, not final field list):

```jsonc
// request
{ "hcp": "1.0", "id": "…", "server": "memory", "source": "magenta",
  "op": "call", "method": "recall", "params": { … } }
// response
{ "hcp": "1.0", "id": "…", "result": { … } }   // or  "error": { code, message }
```

`op` distinguishes the control plane (`describe`, `list`, `health`,
`enable`/`disable`, lifecycle) from invocation (`call`). This is the JSON-RPC
face of what today is `HcpCall` + `HcpServer.call()`.

## 4. Pluggable transport — split by primitive

The protocol (§3) is one thing; **transport** (how the message physically
travels) is separate and **pluggable**, exactly as MCP offers stdio / HTTP /
WebSocket. HCP transports:

- **in-process (direct)** — no serialization. The HcpMagnet hands back a live
  in-process object and the caller invokes it directly. This is the default and
  the fast path.
- **stdio / HTTP** — for a source that is a separate process, an SDK backing
  onto another runtime, or a different language. The Magnet serializes the
  JSON-RPC message across the boundary.

Which transport a primitive uses is **decided by the primitive kind**, and this
is the load-bearing ruling of this contract:

| Primitive | Over the wire? | Transport default | Rationale |
|-----------|----------------|-------------------|-----------|
| **Tool** | **Yes** | wire (in-proc or remote) | Model-visible, `execute(params)→result` is naturally serializable. A Python/Rust/shell source can serve tools. Adds **Tool Search** (§6). |
| **Resource** | **Yes** | wire | Context data (files, text, `SYSTEM.md`). Injected, not called. Trivially serializable. system-prompt lives here (§5). |
| **Prompt** | **Yes** | wire | Slash-command-style prompt templates whose result is injected into the conversation. Serializable. |
| **Capability** | **No (default)** | **in-process live object** | Loop-internal providers: memory, compaction, sandbox, runtime, policy, hooks, context. High-frequency internal calls; live callbacks/streams; direct object references. Serializing every call would tax the hot path and lose live semantics. |

**Red line held.** "HCP is off the execution hot path" remains true because
Capability's default transport is in-process: resolution happens through HCP,
then the resolved live instance is called directly. Wire transport appears only
where a source is genuinely remote/SDK/cross-language — the cost is that
source's inherent remoteness, not a tax on local calls. This is precisely how
Claude Code's own built-in tools (Read/Edit/Bash) do **not** use MCP transport
while external MCP servers do.

**Capabilities keep protocol shape without paying wire cost.** A Capability's
HcpServer still answers `describe`/`list` (so it is discoverable and manageable
like everything else), but its `call` resolves to a live instance handoff rather
than a serialized round trip. In today's code this is the `instance()` face of
`HcpTarget`; Tool/Resource/Prompt primarily use the `call()` (wire) face. The
two faces already coexist — this contract assigns which primitive uses which.

## 5. The four primitives (HCP has one more than MCP)

MCP exposes three server primitives: **Tools**, **Resources**, **Prompts**. HCP
keeps all three (same meanings) and adds a fourth, **Capability**, for
loop-internal live abilities MCP has no concept of.

- **Tool** — model-callable action. `name`/`description`/`parameters`/`execute`.
  The loop calls `tool.execute(...)`; it does not wrap each call in an HCP
  message. Model-visible.
- **Resource** — context **data** injected into the model's context, referenced
  rather than called (MCP references them with `@` mentions). **NEW to our
  Magnet taxonomy** — today Magnet only produces Tool or Capability. `HcpMagnet`
  gains `toResource()`. **system-prompt is a Resource**, with two semantics
  already present in code: *replace/override* (`package-overlay.ts` case
  `system-prompt`, consumed at `resource-loader.ts:661` via `.at(-1)`) and
  *append* (`append-system-prompt`). This mirrors the Agent SDK's output-style
  (default replace, `keep-coding-instructions:true` to layer) vs `append`.
- **Prompt** — a named prompt template surfaced as a command; its result is
  injected into the conversation. prompt-templates map here.
- **Capability** — loop-internal live provider (memory, compaction, sandbox,
  runtime, policy, hooks, context). Invisible to the model. In-process by
  default (§4).

### 5.1 The system-prompt regression this fixes

Codex added `system-prompt` to `CAPABILITY_KINDS`, routing it through
**code-builder resolution** (`system-prompt:<source>` must have a builder). The
AutOmicScience package declares a `system-prompt` with `source="AutOmicScience"`
and only a `content_path` (a `SYSTEM.md` file) — it supplies **content, not a
code provider** — so assembly emitted `capability_factory_missing` and one test
failed. Root cause: a **Resource was classified as a Capability**. Fix:
system-prompt is a Resource; remove it from `CAPABILITY_KINDS`; it flows through
the existing resource path (which already implements override/append). The
Capability primitive is reserved for real code providers (e.g. the pi
`SystemPromptProvider` that owns `formatSkillsForSystemPrompt` / `loadDescriptor`
logic — a single source's implementation).

## 6. Tool layer — deeper, needs a grouping layer + Tool Search

This section resolves the two-level shape flagged in §2.1. Tools are one level
deeper than capabilities. Capabilities are `memory/<source>/`;
tools are `tools/<toolname>/<source>/` (e.g. `tools/bash/{magenta,pi}/`). Three
consequences:

- **Per-tool-type HcpServer.** Each tool type (`bash`, `read`, `edit`, …) is a
  slot with its own sources, so it gets its own HcpServer, exactly like a
  capability slot — just nested under the `tools/` namespace. The **HcpClient
  is still global-single**; there is not one client per tool.
- **The `tools/` namespace grouping node (open, from §2.1).** Whether `tools/`
  itself needs a thin intermediate router above the per-tool-type Servers is the
  open question carried from the design conversation. Current lean: **no
  dedicated grouping HcpServer** — the global HcpClient routes
  `tools/<type>` names straight to the per-tool-type Server, and Tool Search
  (below) provides the only aggregation the `tools/` layer needs (name
  enumeration + deferred schemas). Revisit only if a tool-group-level control
  plane (bulk enable/disable of a whole tool family) turns out to be needed.
- **Tool Search (build now).** Tools are numerous and model-visible, so loading
  every tool's full schema at session start burns context. HCP adopts MCP-style
  **deferral**: at session start only tool **names + short instructions** load;
  full schemas are fetched on demand when the model needs a tool. This keeps
  context flat as the tool count grows. Capabilities need no search — they are
  few, model-invisible, and resolved once at assembly.

## 7. Naming migration map

Retire the old names. The three role names in §2 are the only HCP role names.

| Old (retire) | New | Refs | Notes |
|--------------|-----|------|-------|
| `HcpRegistry` (class) | **`HcpClient`** | ~49 | The global router/resolver. |
| `HcpTarget` (interface) | **`HcpServer`** | ~57 | Per-module/slot endpoint. |
| `Magnet` / `toHcpTarget()` | **`HcpMagnet`** | ~45 | Relocates into source folders (§8). |
| `HcpTargetDescription` | **`HcpServerDescription`** | ~30 | Return of `describe()`. |
| `HcpCall` | **`HcpRequest`** (+`HcpResponse`) | ~32 | JSON-RPC envelope (§3). |
| `HcpContext` | `HcpContext` (keep) | ~4 | Ambient call context. |
| `CapabilityBinding` | `CapabilityBinding` (keep) | ~10 | Capability primitive payload. |
| `resolveCapability(name)` | keep | — | The by-name resolution entry point on HcpClient. |

This is a mechanical, wide rename (~220 sites across `harness/` and `pi/`) and
must be a dedicated, isolated step (no behavior change in the same commit).

## 8. Magnet relocation — dissolve the central table

Today magnets are a central table `BUILTIN_CAPABILITY_BUILDERS` in
`hcp/magnet/capability.ts` (`"memory:magenta": async () => …`). That table
is a **second registry** in spirit and contradicts "exactly one HCP" and "Magnet
lives in the source folder".

Target: each source owns its Magnet as a normal module
(`memory/magenta/magnet.ts`, `compaction/pi/magnet.ts`, …). The package overlay
discovers and constructs the source-declared Magnet during selection; there is
no central builder map. `DEFAULT_CAPABILITY_SOURCES` and `CAPABILITY_KINDS` are
replaced by per-module descriptors declaring their kind, sources, default
source, primitive kind, and node attributes (§9).

## 9. Node attributes — hot-swap and bundling

Every slot carries two attributes, forming a mostly-discrete selection graph
with a few edges:

- **`hotSwappable: boolean`** — may the selection change mid-session? Tools and
  skills: yes (they can come and go, aligned with Tool Search deferral). Memory
  and other stateful capabilities: no — frozen after session start. *Not
  implemented today (everything is assembly-time-fixed); this is a new feature.*
- **`bundledWith: [...]`** — "select A ⇒ select B". This is the bundle mechanism
  already built by Codex (`bundles = [...]` TOML field with
  `package_bundle_applied` / `_conflict` / `_missing` diagnostics; sandbox↔runtime
  declared). These are the **edges** on the selection graph; most nodes have
  none.

## 10. Invariants (must not break)

1. **Exactly one HcpClient.** No parallel capability/factory registry. Selection
   is a responsibility of the client. (Dissolving the central builder table, §8,
   serves this.)
2. **Every module has one HcpServer**; every source has one HcpMagnet, which is
   the sole boundary converging that source into the slot.
3. **HCP is off the execution hot path.** Capability transport is in-process by
   default (§4); resolution goes through HCP, the resolved instance is invoked
   directly.
4. **Consumers are source-agnostic.** No consumer names a source or falls back to
   a source-specific import.
5. **HCP/HcpMagnet are not themselves selectable runtime components.**
6. **Only three role names.** `HcpClient`, `HcpServer`, `HcpMagnet` (§2, §7).

## 11. Work items (superseding the old rollout order)

1. **Write this doc** ✅ (this file).
2. **Naming migration** (§7) — mechanical rename, isolated commit.
3. **Add the Resource primitive** (§5) — `HcpMagnet.toResource()`; register
   system-prompt / prompt-templates as Resources.
4. **Fix the AutOmicScience regression** (§5.1) — remove `system-prompt` from
   `CAPABILITY_KINDS`; rides on step 3.
5. **Relocate Magnets** (§8) — dissolve the central builder table.
6. **Tool Search** (§6) — MCP-style deferral.
7. **Hot-swap attribute** (§9) — new feature.
8. **Re-align the old #21–#29 tasks** to this contract (many prior assumptions
   changed: primitives, transport, naming).

Verification for every step: `harness npm run build` + full suite green (no
regression vs the current 229-test baseline — note the 1 currently-failing test
is the AutOmicScience regression that step 4 fixes), `npm run check:structure`
green, `pi/coding-agent` build green. Switchability proven by test where a slot
has multiple sources.
