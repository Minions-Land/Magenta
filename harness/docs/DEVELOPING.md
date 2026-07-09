# Developing on the Magenta3 Harness

This is the task-oriented guide for adding your own things to the harness. It
tells you *what to create, where, and what rules to follow* for the four things
you can build:

1. **A tool** — a function the model can call (`bash`, `read`, an omics compute step).
2. **A capability source** — an implementation of a loop slot (`memory`, `policy`, `runtime`, …).
3. **A resource** — content wired into assembly (`system-prompt`, `skill`, `prompt`, `theme`, `brand`).
4. **A package** — a shippable bundle of the above under `packages/`.

For the *why* behind the architecture, read `docs/governance/hcp-architecture.md`
(the authoritative contract). For the layered reference, read `../README.md` and
`../hcp/README.md`. This guide is the practical entry point.

---

## The model in one paragraph

The harness is organized as **Module → capability → source**. A *module* is a
mechanism the loop needs (e.g. `memory`). A *capability* is a slot the module
fills. A *source* is who implements it — always an **origin-agent name**
(`pi`, `magenta`, `codex`, `claude-code`, …), never a programming language or a
runtime protocol. Implementations are separated by source, not by tech:
Rust/Python/MCP/process details live *inside* a source directory, they never
become a source directory. Components self-describe via TOML and are discovered
by the registry; a thin **HcpMagnet** binds each one into the uniform interface
the loop consumes. HCP is assembly-time only — the loop calls `tool.execute()`
directly, off the HCP path.

### Four primitives (know which one you are building)

| Primitive | What it is | Model sees it? | Needs a code builder? |
|---|---|---|---|
| **Tool** | A callable function | Yes (in the tool list) | Yes (execute fn) |
| **Capability** | A loop-internal slot impl | No | Yes (build fn) |
| **Resource** | Content merged at assembly | Indirectly (as content) | **No** |
| **Prompt** | A named prompt template | On invocation | Yes |

> **The one rule that bites people (spec §5.1):** a `system-prompt` (or `skill`,
> `theme`, `brand`) is a **Resource**, not a Capability. It carries a
> `content_path`, not a code provider. Never add it to `CAPABILITY_KINDS` and
> never give it a capability builder — doing so makes assembly emit
> `capability_factory_missing`. Content flows through the resource path.

---

## Rules (the short list)

### HCP Naming Quick Reference

**All HCP-related names follow the entity-tree iron law** (complete rules: `docs/governance/hcp-naming.md`):

1. **Naming hierarchy = entity tree.** Every capital letter starts a new level and must have a real parent entity in code.
2. **Level 2 is always a role:** `Client` / `Server` / `Magnet` (the only three). No fourth role.
3. **Everything Hcp-related has the `Hcp` prefix.** No exceptions.

**Quick checks when naming**:
- Protocol data (requests/responses) → hang under `Server`: `HcpServerRequest`, `HcpServerResponse`
- Magnet artifacts (resources/bindings) → hang under `Magnet`: `HcpMagnetResource`, `HcpMagnetBinding`
- Each capital = must have parent entity. Writing `HcpServerRequestValidator`? Then `HcpServerRequest` must exist as an entity.
- If intermediate entity doesn't exist, keep modifiers lowercase: `HcpClientcapabilityprefix` (no `Capability` entity).

**Examples**:
- ✅ `HcpMagnetProcess` — Magnet (role) + Process (identity)
- ✅ `HcpServerRequest` — Server (role) + Request (protocol data entity)
- ❌ `HcpProcessMagnet` — wrong order (level 3 before level 2)
- ❌ `HcpRequest` — missing role at level 2

See `docs/governance/hcp-naming.md` for complete specification.

### General Rules

1. **Source = origin agent, not tech.** Directories are `pi/`, `magenta/`,
   `codex/`, `claude-code/`. Put Rust/Python/process/MCP details *inside* the
   owning source.
2. **One-of invariant.** A magnet produces at most ONE of tool / capability /
   resource. Don't build a hybrid.
3. **No second selection registry (spec §8, §10.1).** Which source wins a slot
   is decided once by the HcpClient / package overlay. Your magnet only *binds*;
   it makes no selection decisions. The builder/default/hotSwappable tables are
   *derived* from the `hcp-client/assembly/sources.ts` barrel — never hand-maintain a
   central builder map.
4. **Keep the magnet thin.** It is a last-inch adapter: binding + (for tools)
   transport selection only. No business logic.
5. **Frozen by default (spec §9).** Capabilities are stateful and non-hot-swap
   unless you explicitly set `hotSwappable: true` on a stateless provider.
6. **Contract modules stay flat.** Pure type/interface modules (`messages/`,
   `types/`) have no source subdirectories.
7. **Package-level imports only.** Consumers import from `@magenta/harness`
   (the `index.ts` barrel), never deep-import internals, and never name a
   specific source.
8. **Every change passes the gate** (see the last section).

---

## Task 1 — Add a tool

A tool is an independent module under `harness/modules/tools/<name>/`.

```
harness/modules/tools/my-tool/
  my-tool.toml         — kind="tool", name, description, parameters (JSON Schema)
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
2. Implement the execute function in `pi/my-tool.ts` and export it from
   `harness/index.ts`.
3. Register it in `harness/harness.toml` under `[[components]]`.

**In-process (default):** a TypeScript execute function is wrapped by
`NativeToolMagnet`. **Process/CLI-backed:** set `runtime = "process"` with
`command`/`args` in the toml (wrapped by `ProcessToolMagnet`). **Out-of-process
JSONL:** `HcpProcessMagnet`. You do not instantiate these yourself for package
tools — the overlay picks the cable from the toml (see Task 4).

Sub-operations of an existing tool live under that tool's source dir (e.g.
`tools/read/magenta/read-url`), not as new top-level tools.

---

## Task 2 — Add a capability source

Pick this when you are implementing one of the loop slots: `compaction`,
`context`, `hook`, `memory`, `policy`, `runtime`, `sandbox`. You are adding a
new *source* to an existing slot (or, rarely, a new slot).

```
harness/modules/memory/
  memory.toml
  magenta/            ← existing source
    magnet.ts
    ...impl
  my-source/          ← your new source
    magnet.ts         ← the binding
    ...impl
```

1. Implement your provider in `harness/modules/memory/my-source/*.ts`.
2. Bind it with `harness/modules/memory/my-source/magnet.ts`:
   ```typescript
   import type { CapabilitySourceMagnet } from "../../../hcp-contract/hcp-magnet.ts";
   import { MyMemoryProvider } from "./my-memory.ts";

   /** The my-source binding for the `memory` capability (spec §8). */
   export const memoryMySourceMagnet: CapabilitySourceMagnet = {
     kind: "memory",         // the capability kind
     source: "my-source",    // origin-agent name
     isDefault: false,       // is this the default source for the slot?
     // hotSwappable: true,  // ONLY if the provider is stateless (§9); omit = frozen
     build: () => new MyMemoryProvider({}),
   };
   ```
3. Register it in the barrel `harness/hcp-client/assembly/sources.ts` — add a static
   import and put it in the `CAPABILITY_SOURCE_MAGNETS` array. That's it: the
   builder table, default-source map, and hotSwappable map in
   `hcp-client/assembly/capability.ts` are derived from this array. **Do not** add a
   central builder literal — the barrel is a dumb aggregation with no selection
   logic, and that is the invariant.

Which source is active for a slot is a selection decision made by the package
overlay / HcpClient, never in your magnet.

---

## Task 3 — Add a resource

Resources are content-only: `system-prompt`, `skill`, `prompt`, `theme`,
`brand`. They flow through the resource path and need **no code builder**.

Declare them with a descriptor toml pointing at content:

```toml
kind = "system-prompt"
name = "system-prompt"
content_path = "SYSTEM.md"     # package-local markdown
```

`ResourceMergeMode` is `replace` (default) or `append` — e.g.
`append-system-prompt` appends to the base prompt rather than replacing it.
Never route a resource through `CAPABILITY_KINDS` (spec §5.1).

---

## Task 4 — Ship a package

A package under `packages/<Name>/` bundles tools, skills, a system prompt, a
brand, and (for process/python tools) its runtime + environment. See
`packages/AutOmicScience/` for a full worked example and
`packages/templates/harness-package/` for the template.

Skeleton:

```
packages/MyPackage/
  package.toml                    — manifest: id, kind, [[components]]
  system-prompt/system-prompt.toml (+ SYSTEM.md)
  brands/<brand>/
  skills/<skill>/SKILL.md
  tools/<tool>/<tool>.toml
```

`package.toml` lists each component with `kind`, `name`, `path`:

```toml
schema_version = "magenta.package.v1"
id = "MyPackage"
kind = "domain"

[[components]]
kind = "system-prompt"
name = "system-prompt"
path = "system-prompt/system-prompt.toml"

[[components]]
kind = "tool"
name = "my_compute"
path = "tools/my-compute/my-compute.toml"
```

**Package tools and transport.** A package tool's toml declares its cable via
`runtime`:
- no `runtime` / native → in-process,
- `runtime = "process"` with `command`/`args` → `ProcessToolMagnet`,
- `runtime = "<name>"` matching a `python-runtime` component named `<name>` →
  `PythonModuleToolMagnet` (Python module backed).

The overlay (`hcp-client/overlay/`) resolves these; you declare, it wires. See
`hcp-client/overlay/README.md` for the exact cable rules.

**Layout note.** Packages express origin via the `source =` field, and the
package itself is the source scope, so package components use a flat
`tools/<tool>/` / `skills/<skill>/` layout — the `<name>/<source>/` directory
layout is for in-harness components under `harness/modules/tools/`, not for package
components.

**Big binaries stay out of git.** Materialized environments (`.pixi/`, conda
envs) and run outputs (`runs/`) are gitignored. Ship the manifest
(`pixi.toml`) and lock (`pixi.lock`), not the built environment.

---

## The verification gate (run before every change lands)

From `harness/`:

```bash
npm run build            # tsc + asset copy — must be green
npm test                 # vitest — no regression vs the current baseline
npm run check:structure  # enforces the module/source layout rules
npm run inspect          # resolves the real registry + packages; check for diagnostics
```

When your change touches pi, also:

```bash
npm --prefix pi/coding-agent run build
```

`npm run inspect` is the fastest way to confirm a new component resolves: it
prints every module, its ready implementations, and every package's components
with their executable transport — and surfaces diagnostics like
`capability_factory_missing` if you misclassified a resource as a capability.

If a step fails twice, stop and diagnose the root cause instead of patching
incrementally.
