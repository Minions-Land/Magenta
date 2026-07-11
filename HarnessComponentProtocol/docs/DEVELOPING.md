# Developing on the Magenta3 Harness

This is the task-oriented guide for adding your own things to the harness. It
tells you *what to create, where, and what rules to follow* for the four things
you can build:

1. **A tool** — a function the model can call (`bash`, `read`, a project-specific operation).
2. **A Source for a capability slot** — an implementation of a loop slot
   (`memory`, `policy`, `runtime`, …).
3. **A resource** — content wired into assembly (`system-prompt`, `skill`, `prompt`, `theme`, `brand`).
4. **A package** — an independently shipped bundle that follows the generic
   package contract and is published from its own GitHub repository.

For the *why* behind the architecture, read `governance/hcp-architecture.md`
(the authoritative contract). For Package integration support, read
`../_magenta/packages/README.md`. This guide is the practical entry point.

---

## The model in one paragraph

The ownership chain is **HcpClient → Module HcpServer → Source HcpMagnet →
product**. A *module* is a mechanism the loop needs (e.g. `memory`). A
*capability* is one possible Magnet product and the address/slot semantic for a
live loop value; it is not an HCP role or assembly layer. A *source* is who
implements the product and is ordinarily an **origin-agent name**
(`pi`, `magenta`, `codex`, `claude-code`, …), never a programming language or a
runtime protocol. The sole host-supplied exception is the reserved `descriptor`
Source: an owning Module may declare `descriptor/HcpMagnet.ts` to adapt host or
Package descriptor settings into a Tool or Resource product. Implementations
are otherwise separated by source, not by tech: Rust/Python/MCP/process details
live *inside* an origin-agent source directory, they never become a source
directory. Repository components are declared in TOML and projected by codegen
into `HCP_SERVERS` and `HCP_MAGNETS`; the real module **HcpServer** owns
management and routing while a thin source **HcpMagnet** produces one tool,
capability, or resource. HCP is assembly-time only — the loop calls
`tool.execute()` directly, off the HCP path.

### Three Magnet products (know which one you are building)

| Product | What it is | Model sees it? | Magnet output |
|---|---|---|---|
| **Tool** | A callable function | Yes (in the tool list) | `toTool()` |
| **Capability** | A loop-internal slot value | No | `toCapability()` |
| **Resource** | Content merged at assembly | Indirectly (as content) | `toResource()` |

Prompt-template behavior belongs to the appropriate Capability or Resource
path. It is not a fourth Magnet product or method.

> **Product distinction:** package content such as a `system-prompt`, `skill`,
> `theme`, or `brand` is a **Resource**, not a Capability. It carries a
> `content_path`, not a code provider. A repository `system-prompt` Source may
> separately provide live formatting behavior as a Capability; the two products
> remain distinct.

---

## Rules (the short list)

### HCP Naming Quick Reference

**All HCP-related names follow the entity-tree iron law** (complete rules: `governance/hcp-naming.md`):

1. **Naming hierarchy = entity tree.** Every capital letter starts a new level
   and must have a real parent entity in code.
2. **Level 2 is always a role:** `Client` / `Server` / `Magnet` (the only
   three). No fourth role.
3. **Everything Hcp-related has the `Hcp` prefix.** No exceptions.

**Quick checks when naming**:
- Protocol data (requests/responses) → hang under `Server`:
  `HcpServerRequest`, `HcpServerResponse`
- Magnet artifacts and transport data → hang under `Magnet`:
  `HcpMagnetResource`, `HcpMagnetBinding`, `HcpMagnetJsonlRequest`
- Each capital = must have parent entity. Writing `HcpServerRequestValidator`?
  Then `HcpServerRequest` must exist as an entity.
- If an intermediate entity does not exist, keep modifiers lowercase:
  `HcpClientcapabilityprefix` (no `Capability` entity).

**Examples**:
- ✅ `HcpMagnetProcess` — concrete Magnet-side JSONL transport entity; an
  owning source may inject and use it
- ✅ `HcpMagnetJsonlRequest` — JSONL request owned by the Magnet-process entity
- ✅ `HcpServerRequest` — Server (role) + Request (protocol data entity)
- ❌ `HcpProcessMagnet` — wrong order (level 3 before level 2)
- ❌ `HcpRequest` — missing role at level 2

See `governance/hcp-naming.md` for complete specification.

### General Rules

1. **Source = origin agent, except the reserved host descriptor adapter.**
   Ordinary implementation directories are `pi/`, `magenta/`, `codex/`, or
   `claude-code/`. The repository-declared `descriptor/` Source exists only to
   adapt host or Package descriptor settings through the owning Module's
   `descriptor/HcpMagnet.ts`; it is not a general naming escape. Put
   Rust/Python/process/MCP details *inside* the owning origin-agent Source.
2. **One-of invariant.** A source-local role class `HcpMagnet` produces exactly
   ONE of tool / capability / resource. Do not build a hybrid and do not add
   `toHcpServer()`. Magnet-side entities such as `HcpMagnetProcess` are
   injectable helpers, not source role classes or products.
3. **One selection path.** TOML declares available Sources and the
   repository-default choice; explicit host or Package input may override that
   choice before assembly. Your Magnet only *binds* and makes no selection
   decisions. Codegen writes `.HCP/assembly/sources.generated.ts`:
   `HCP_SERVERS` is the Server map and `HCP_MAGNETS` is the one Magnet list.
   Consumers filter `HCP_MAGNETS`; never create product-specific Magnet lists.
4. **Keep the Magnet thin.** It binds a source and produces its one product. The
   real Module `HcpServer.ts` owns management behavior. HCP JSONL plumbing lives
   under `.HCP/transport/`; generic MCP/runtime support lives under `_magenta/`
   or the Source implementation. Transport is not a Module and owns no Server
   or address.
5. **Frozen by default.** Live Capability products are stateful and
   non-hot-swap unless their component TOML explicitly sets
   `hot_swappable = true` for a stateless provider. Codegen passes that node
   property into `HcpMagnet.build()`; the authoritative rule lives in the
   [assembly contract](./governance/hcp-architecture.md#4-assembly-and-selection).
6. **Host support is not a Module.** `_magenta/packages`, `_magenta/mcp`,
   `_magenta/session`, `_magenta/env`, `_magenta/messages`, `_magenta/types`,
   and `_magenta/utils` are private host/shared support libraries. They own no
   HCP roles, appear in no generated assembly, and do not form a contract layer.
   `.HCP/` contains only Hcp-prefixed protocol, assembly, and explicit HCP
   transport plumbing with the same non-Module boundary.
7. **Package-level imports only.** Consumers import from `@magenta/harness`
   (the `index.ts` barrel), never deep-import internals, and never name a
   specific Source.
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
   product = "tool"
   name = "my_tool"
   source = "pi"
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
4. Declare it in `HarnessComponentProtocol/harness.toml`, export its public
   product from `HarnessComponentProtocol/index.ts`, and run
   `npm run generate:hcp-sources`.

**In-process tools:** the source-local `HcpMagnet` creates the ordinary tool and
returns it from `toTool()`. **Package process/Python/MCP tools:** descriptor
metadata selects a `ProcessTool`, `PythonModuleTool`, or `McpTool` product
adapter. Those adapters are not source roles and must stay under a real tool
Module/Server and source `HcpMagnet`.
**Out-of-process JSONL HCP:** an owning Source Magnet may explicitly inject and
use `.HCP/transport/hcp-process.ts::HcpMagnetProcess`. The transport is not a
Module or Source role, is never auto-assembled, and owns no Server. Default
production assembly does not instantiate or reference it.

Sub-operations of an existing tool live under that tool's source dir (e.g.
`tools/read/magenta/read-url`), not as new top-level tools.

---

## Task 2 — Add a Source for a capability slot

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
  codex/              ← your new Source
    HcpMagnet.ts      ← the binding
    ...impl
```

1. Implement your provider in `HarnessComponentProtocol/memory/codex/*.ts`.
2. Bind it with `HarnessComponentProtocol/memory/codex/HcpMagnet.ts`:
   ```typescript
   import type { HcpMagnetBinding } from "../../.HCP/HcpMagnetTypes.ts";
   import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
   import { MyMemoryProvider } from "./my-memory.ts";

   export class HcpMagnet {
     static readonly module = "memory";
     static readonly kind = "memory";
     static readonly source = "codex";
     static build(context: HcpMagnetBuildContext) {
       return new HcpMagnet(context);
     }

     readonly kind = "capability:memory";
     readonly hotSwappable: boolean;
     private readonly provider: MyMemoryProvider;

     constructor(context: HcpMagnetBuildContext) {
       this.hotSwappable = context.hotSwappable ?? false;
       this.provider = new MyMemoryProvider({ workspaceRoot: context.repoRoot });
     }

     toCapability(): HcpMagnetBinding {
       return {
         kind: "memory",
         name: "memory",
         source: "codex",
         instance: this.provider,
       };
     }
   }
   ```
3. Ensure the owning module has its real `memory/HcpServer.ts`. For a new module,
   add that class; for another source of `memory`, reuse the existing Server.
4. Declare the Source in the component TOML and run
   `npm run generate:hcp-sources`. Do not hand-edit `sources.generated.ts` or
   add a central builder literal.

The component TOML declares available Sources and its default-selected Source.
An explicit host or Package choice can replace it before the HcpClient assembles
the slot. The Magnet never decides which Source is active.

---

## Task 3 — Add a resource

Package resources such as `system-prompt`, `skill`, `prompt`, `theme`, and
`brand` are content-only. They need no Package-specific code builder. Package
assembly converts each component into `HcpMagnetResourcebuildsettings` and sends
it through the existing owning Module's `descriptor/HcpMagnet`; the resulting
Resource is routed by that Module's real `HcpServer`. Package descriptors do not
create package-local HCP Modules. Repository-declared skill Sources remain real
Source Magnets under
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
Append fragments must use distinct names because every Resource owns one stable
`kind:name` address. Do not build content-only resources as live capability
bindings or bypass HcpClient with a derived Package resource table.

---

## Task 4 — Develop a domain package

Magenta3 retains the generic package contract and template under `packages/`:

```text
packages/
  README.md
  templates/harness-package/
```

Concrete domain expert packages will be maintained and published in independent
GitHub repositories. Do not vendor them into Magenta3 or infer a sibling
checkout. A future acquisition layer will own download, version selection, verification,
and caching; it is intentionally out of scope here. For now, external callers
can provide a local directory containing Packages that have already been
downloaded. `discoverHarnessPackages()` and `loadPackageOverlay()` accept an
optional `packagesRoot` for this purpose. If omitted, they fall back only to
`<repoRoot>/packages`; they never scan a sibling checkout, `MagentaPackages`, or
a git submodule.

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
npm run inspect          # checks generated declarations and configured packages
```

When your change touches pi, also:

```bash
cd ../pi/coding-agent
npx tsgo --noEmit
npm test
```

`npm run inspect` is the fastest way to inspect declared Modules, generated
Sources, and explicitly configured Package components. Treat any emitted
diagnostic as a declaration, build, or ownership error to resolve at its source.

If a step fails twice, stop and diagnose the root cause instead of patching
incrementally.
