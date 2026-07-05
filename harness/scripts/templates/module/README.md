# Harness Module Template

This directory provides the **standard layout template** for all harness modules.

## Standard Module Structure

Every harness module follows this pattern:

```
harness/<module-name>/
  <module-name>.toml    — Registration metadata (kind, name, description, source)
  pi/                   — Pi-sourced implementations (TypeScript)
    *.ts                — Implementation files
    magnet.ts           — Capability modules only: the source's HcpMagnet binding
  magenta/              — Magenta-sourced implementations, possibly Rust/MCP-backed
    magnet.ts           — (per source, for capability modules)
  codex/                — (future) Codex-sourced implementations
  claude-code/          — (future) Claude Code-sourced implementations
  README.md             — Module documentation
```

> **Capability modules need a Magnet per source (spec §8).** A capability
> module (e.g. `compaction`, `context`, `memory`, `policy`, `runtime`,
> `sandbox`) is a *slot* that can bind several sources. Each source binds itself
> into that slot with a thin `<module>/<source>/magnet.ts` exporting a
> `CapabilitySourceMagnet`, and registers it in the dumb barrel
> `harness/hcp-client/assembly/sources.ts`. Tools, Resources (e.g. `system-prompt`), and
> pure contract modules do **not** use a capability magnet — see the Magnet
> section below.

## Key Principles

1. **Source Separation**: Implementations are organized by origin Agent/source (`pi/`, `magenta/`, `codex/`, `claude-code/`, etc.), not by runtime mechanism. Rust, MCP, Python, and process details live inside the owning Source directory.

2. **Top-Level Registration**: The `.toml` file at module root declares the component for the harness registry. It's indexed in `harness/harness.toml`.

3. **Per-Module Documentation**: Each module has its own `README.md` explaining purpose, available sources, and API.

4. **Contract Modules Exception**: Pure contract/type modules (like `messages/`, `types/`) stay flat with no source subdirectories, since they contain no implementations.

## Example: Adding a New Module

1. Create the directory structure:
   ```bash
   mkdir -p harness/my-module/pi
   ```

2. Write the registration file `harness/my-module/my-module.toml`:
   ```toml
   kind = "component-type"  # e.g., "skill", "tool", "prompt-template"
   name = "my-module"
   description = "What this module does"
   source = "pi"
   
   [parameters]
   # Optional: if this component takes parameters
   ```

3. Implement in `harness/my-module/pi/*.ts`

4. Document in `harness/my-module/README.md`

5. Register in `harness/harness.toml`:
   ```toml
   [[components]]
   kind = "component-type"
   name = "my-module"
   description = "..."
   path = "my-module/my-module.toml"
   ```

6. Export from `harness/index.ts`:
   ```typescript
   export * from "./my-module/pi/my-module.js";
   ```

## Capability Magnet (spec §8)

If your module is a **capability** — a slot resolved by the HcpClient at
assembly time (`compaction`, `context`, `hook`, `memory`, `policy`, `runtime`,
`sandbox`) — each source must bind itself into the slot with a thin Magnet.

1. Add `harness/modules/my-module/<source>/magnet.ts`:
   ```typescript
   import type { CapabilitySourceMagnet } from "../../../hcp-contract/hcp-magnet.ts";
   import { MyProvider } from "./my-module.ts";

   /** The <source> source's binding for the `my-module` capability (spec §8). */
   export const myModuleMagnet: CapabilitySourceMagnet = {
     kind: "my-module",       // the capability kind (matches the .toml kind)
     source: "pi",            // origin-agent source name
     isDefault: true,         // is this the default source for the slot?
     // hotSwappable: true,   // opt in only if the provider is stateless (§9); omit = frozen
     build: () => new MyProvider({}),
   };
   ```

2. Register it in the dumb barrel `harness/hcp-client/assembly/sources.ts` (a static
   re-export list, NO selection logic — selection is the HcpClient's job). The
   builder table, default-source map, and hotSwappable map are DERIVED from this
   barrel in `hcp-client/assembly/capability.ts`; do not hand-maintain a central builder
   literal.

**Keep the Magnet thin.** It is a last-inch adapter: binding + (for tools)
transport selection only, never business logic. A magnet produces at most ONE
of tool / capability / resource (the one-of invariant).

## Resources are not capabilities

Content-only components (`system-prompt` via `content_path`, `skill`, `prompt`,
`theme`, `brand`) are **Resources**, not capabilities. They flow through the
resource path and must NOT be added to `CAPABILITY_KINDS` or given a code
builder — doing so triggers a `capability_factory_missing` error (spec §5.1).

## Tools Exception

Tools follow a slightly different pattern — each tool is an independent module under `tools/`:

```
harness/modules/tools/
  <tool-name>/
    <tool-name>.toml
    pi/
      <tool-name>.ts
    README.md
```

See `tools/bash/`, `tools/edit/` etc. for examples.
