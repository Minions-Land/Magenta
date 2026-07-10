# Developing on the Magenta3 Harness

This is the task-oriented guide for adding your own things to the harness. It
tells you *what to create, where, and what rules to follow* for the four things
you can build:

1. **A tool** — a function the model can call (`bash`, `read`, a project-specific operation).
2. **A capability source** — an implementation of a loop slot (`memory`, `policy`, `runtime`, …).
3. **A resource** — content wired into assembly (`system-prompt`, `skill`, `prompt`, `theme`, `brand`).
4. **A package** — an independently shipped bundle that follows the generic
   package contract; domain implementations are owned by `MagentaPackages`.

For the *why* behind the architecture, read `governance/hcp-architecture.md`
(the authoritative contract). For package integration plumbing, read
`../.HCP/overlay/README.md`. This guide is the practical entry point.

---

## The model in one paragraph

The harness is organized as **Module → capability → source**. A *module* is a
mechanism the loop needs (e.g. `memory`). A *capability* is a slot the module
fills. A *source* is who implements it — always an **origin-agent name**
(`pi`, `magenta`, `codex`, `claude-code`, …), never a programming language or a
runtime protocol. Implementations are separated by source, not by tech:
Rust/Python/MCP/process details live *inside* a source directory, they never
become a source directory. Components self-describe via TOML and are discovered
by the registry; the real module **HcpServer** owns management and routing while
a thin source **HcpMagnet** produces one tool, capability, or resource. HCP is
assembly-time only — the loop calls `tool.execute()` directly, off the HCP path.

### Three Magnet products (know which one you are building)

| Primitive | What it is | Model sees it? | Needs a code builder? |
|---|---|---|---|
| **Tool** | A callable function | Yes (in the tool list) | Yes (execute fn) |
| **Capability** | A loop-internal slot impl | No | Yes (build fn) |
| **Resource** | Content merged at assembly | Indirectly (as content) | **No** |

Prompt-template behavior belongs to the appropriate Capability or Resource
path. It is not a fourth Magnet product or method.

> **The one rule that bites people (spec §5.1):** a `system-prompt` (or `skill`,
> `theme`, `brand`) is a **Resource**, not a Capability. It carries a
> `content_path`, not a code provider. Never add it to `CAPABILITY_KINDS` and
> never give it a capability builder — doing so makes assembly emit
> `capability_factory_missing`. Content flows through the resource path.

---

## Rules (the short list)

### HCP Naming Quick Reference

**All HCP-related names follow the entity-tree iron law** (complete rules: `governance/hcp-naming.md`):

1. **Naming hierarchy = entity tree.** Every capital letter starts a new level and must have a real parent entity in code.
2. **Level 2 is always a role:** `Client` / `Server` / `Magnet` (the only three). No fourth role.
3. **Everything Hcp-related has the `Hcp` prefix.** No exceptions.

**Quick checks when naming**:
- Protocol data (requests/responses) → hang under `Server`: `HcpServerRequest`, `HcpServerResponse`
- Magnet artifacts and transport data → hang under `Magnet`:
  `HcpMagnetResource`, `HcpMagnetBinding`, `HcpMagnetJsonlRequest`
- Each capital = must have parent entity. Writing `HcpServerRequestValidator`? Then `HcpServerRequest` must exist as an entity.
- If intermediate entity doesn't exist, keep modifiers lowercase: `HcpClientcapabilityprefix` (no `Capability` entity).

**Examples**:
- ✅ `HcpMagnetProcess` — concrete Magnet-side JSONL transport entity; an
  owning source may inject and use it
- ✅ `HcpMagnetJsonlRequest` — JSONL request owned by the Magnet-process entity
- ✅ `HcpServerRequest` — Server (role) + Request (protocol data entity)
- ❌ `HcpProcessMagnet` — wrong order (level 3 before level 2)
- ❌ `HcpRequest` — missing role at level 2

See `governance/hcp-naming.md` for complete specification.

### General Rules

1. **Source = origin agent, not tech.** Directories are `pi/`, `magenta/`,
   `codex/`, `claude-code/`. Put Rust/Python/process/MCP details *inside* the
   owning source.
2. **One-of invariant.** A source-local role class `HcpMagnet` produces exactly
   ONE of tool / capability / resource. Do not build a hybrid and do not add
   `toHcpServer()`. Magnet-side entities such as `HcpMagnetProcess` are
   injectable helpers, not source role classes or products.
3. **No second selection registry (spec §8, §10.1).** Which source wins a slot
   is decided once by the HcpClient / package overlay. Your magnet only *binds*;
   it makes no selection decisions. Built-in entities are generated in
   `.HCP/assembly/sources.generated.ts` from TOML: `HCP_SERVERS` is the Server
   map and `HCP_MAGNETS` is the one Magnet list. Consumers filter
   `HCP_MAGNETS`; never create derived tool, skill, capability, or resource
   Magnet lists.
4. **Keep the Magnet thin.** It binds a source and produces its one product. The
   real module `HcpServer.ts` owns management behavior; transport plumbing lives
   under `.HCP/transport/` or the source implementation. Transport is not a
   Module, owns no Server, and cannot register its own address.
5. **Frozen by default (spec §9).** Capabilities are stateful and non-hot-swap
   unless their component TOML explicitly sets `hot_swappable = true` for a
   stateless provider. Codegen passes that node property into `HcpMagnet.build()`.
6. **Host support is not a Module.** `_magenta/session`, `_magenta/env`,
   `_magenta/messages`, `_magenta/types`, and `_magenta/utils` are private
   host/shared support libraries. They own no HCP roles, appear in no generated
   entity list, and do not form a contract layer. `.HCP/` is protocol and
   assembly plumbing with the same non-Module boundary.
7. **Package-level imports only.** Consumers import from `@magenta/harness`
   (the `index.ts` barrel), never deep-import internals, and never name a
   specific source.
8. **Every change passes the gate** (see the last section).

---

## Task 1 — Add a tool

A tool is an independent leaf Module under
`HarnessComponentProtocol/tools/<name>/`. The root `tools/HcpServer.ts` remains
a real grouping Server; each tool leaf also owns its own `HcpServer.ts`.

```
HarnessComponentProtocol/tools/my-tool/
  my-tool.toml         — kind="tool", name, description, parameters (JSON Schema)
  HcpServer.ts         — real tools/my-tool Server
  pi/HcpMagnet.ts      — source connector producing one AgentTool
  pi/my-tool.ts        — the execute implementation (source = pi)
  README.md
```

1. Write `my-tool.toml`:
   ```toml
   kind = "tool"
   name = "my_tool"
   description = "One clear sentence the model reads to decide when to call this."

   [parameters]
   type = "object"
   required = ["path"]

   [parameters.properties.path]
   type = "string"
   description = "What this argument means"
   ```
2. Implement the execute function in `pi/my-tool.ts` and bind it from the bare
   `class HcpMagnet` in `pi/HcpMagnet.ts` through `toTool()`.
3. Add a bare `class HcpServer` in `HcpServer.ts` with
   `moduleName = "tools/my-tool"`.
4. Register it in `HarnessComponentProtocol/harness.toml`, export its public product from
   `HarnessComponentProtocol/index.ts`, and run `npm run generate:hcp-sources`.

**In-process tools:** the source-local `HcpMagnet` creates the ordinary tool and
returns it from `toTool()`. **Package process/Python/MCP tools:** descriptor
metadata selects a `ProcessTool`, `PythonModuleTool`, or `McpTool` product
adapter. Those adapters are not source roles and must stay under a real tool
Module/Server and source `HcpMagnet`.
**Out-of-process JSONL HCP:** an owning source Magnet may explicitly inject and use
`.HCP/transport/hcp-process.ts::HcpMagnetProcess`. The transport is not a
Module or source role, is never auto-assembled, and owns no Server. Default
production assembly does not instantiate or reference it.

Sub-operations of an existing tool live under that tool's source dir (e.g.
`tools/read/magenta/read-url`), not as new top-level tools.

---

## Task 2 — Add a capability source

Pick this when you are implementing one of the loop slots: `compaction`,
`context`, `hook`, `memory`, `policy`, `runtime`, `sandbox`. You are adding a
new *source* to an existing slot (or, rarely, a new slot).

```
HarnessComponentProtocol/memory/
  memory.toml
  HcpServer.ts         ← real module management endpoint
  magenta/            ← existing source
    HcpMagnet.ts
    ...impl
  my-source/          ← your new source
    HcpMagnet.ts      ← the binding
    ...impl
```

1. Implement your provider in `HarnessComponentProtocol/memory/my-source/*.ts`.
2. Bind it with `HarnessComponentProtocol/memory/my-source/HcpMagnet.ts`:
   ```typescript
   import type { HcpMagnetBinding } from "../../.HCP/HcpMagnetTypes.ts";
   import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
   import { MyMemoryProvider } from "./my-memory.ts";

   export class HcpMagnet {
     static readonly module = "memory";
     static readonly kind = "memory";
     static readonly source = "my-source";
     static readonly isDefault = false;

     readonly kind = "capability:memory";
     readonly hotSwappable: boolean;
     private readonly provider: MyMemoryProvider;

     constructor(context: HcpMagnetBuildContext) {
       this.hotSwappable = context.hotSwappable ?? false;
       this.provider = new MyMemoryProvider({ workspaceRoot: context.repoRoot });
     }

     toCapability(): HcpMagnetBinding<MyMemoryProvider> {
       return {
         kind: "memory",
         name: "memory",
         source: "my-source",
         instance: this.provider,
       };
     }
   }
   ```
3. Ensure the owning module has its real `memory/HcpServer.ts`. For a new module,
   add that class; for another source of `memory`, reuse the existing Server.
4. Register the source in TOML and run `npm run generate:hcp-sources`. Do not
   hand-edit `sources.generated.ts` or add a central builder literal.

Which source is active for a slot is a selection decision made by the package
overlay / HcpClient, never in your magnet.

---

## Task 3 — Add a resource

Package resources such as `system-prompt`, `skill`, `prompt`, `theme`, and
`brand` are content-only. They flow through the resource path and need **no
code builder**. Their descriptors do not create package-local HCP Modules;
package assembly attaches them to existing real ownership. Built-in skill
Sources are still real source Magnets under
`skills/<skill>/<source>/`, with both the root `skills/HcpServer.ts` and each
leaf `skills/<skill>/HcpServer.ts` present.

Declare them with a descriptor toml pointing at content:

```toml
kind = "system-prompt"
name = "system-prompt"
content_path = "SYSTEM.md"     # package-local markdown
```

`HcpMagnetResourceMergeMode` is `replace` (default) or `append` — e.g.
`append-system-prompt` appends to the base prompt rather than replacing it.
Never route a resource through `CAPABILITY_KINDS` (spec §5.1).

---

## Task 4 — Develop a domain package

Magenta3 retains the generic package contract and template under `packages/`:

```text
packages/
  README.md
  templates/harness-package/
```

Concrete domain expert packages are independently owned and versioned in the
`MagentaPackages` repository. Do not vendor them into Magenta3 or hardcode the
sibling repository's filesystem location. External discovery and release
coordination must enter through an explicit integration boundary.

The generic package shape remains:

```text
<PackageName>/
  package.toml
  system-prompt/system-prompt.toml (+ SYSTEM.md)
  brands/<brand>/
  skills/<skill>/SKILL.md
  tools/<tool>/<tool>.toml
```

`package.toml` lists each component with `kind`, `name`, and a package-local
`path`. Process, Python, and MCP package tools still converge on ordinary HCP
products through the package overlay. The template documents the schema; it is
not a concrete package or an instruction to create domain content in Magenta3.

---

## The verification gate (run before every change lands)

From `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure  # enforces entity-tree and production role rules
npm run build            # tsc + asset copy — must be green
npm test                 # vitest — no regression vs the current baseline
npm run inspect          # resolves the real registry + configured packages; check diagnostics
```

When your change touches pi, also:

```bash
cd ../pi/coding-agent
npx tsgo --noEmit
npm test
```

`npm run inspect` is the fastest way to confirm a new component resolves: it
prints every module, its ready implementations, and configured package
components, and surfaces diagnostics like
`capability_factory_missing` if you misclassified a resource as a capability.

If a step fails twice, stop and diagnose the root cause instead of patching
incrementally.
