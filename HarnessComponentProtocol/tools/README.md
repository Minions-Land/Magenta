# Tools Modules

`tools/HcpServer.ts` is the real grouping Server, and every declared
`tools/<name>/` leaf is its own Tool Module with an `HcpServer.ts`, component
TOML, and one or more Source `HcpMagnet.ts` files.

## Structure

Each tool is an independent module under `tools/`:

```
tools/
  HcpServer.ts
  bash/
    HcpServer.ts
    bash.toml             — Tool and Source declaration
    pi/HcpMagnet.ts       — Pi Source binding
    pi/bash.ts            — Pi implementation
    magenta/HcpMagnet.ts  — Magenta Source binding
    README.md
  edit/
    edit.toml
    pi/edit.ts
    README.md
  ...
```

## Available Tools

- **bash** — Execute shell commands
- **edit** — File editing with exact text replacement
- **grep** — Pattern search in files
- **read** — Read file contents
- **write** — Write file contents
- **find** — Find files by glob pattern
- **ls** — List directory entries
- **lsp** — LSP-style language intelligence queries
- **todo** — Session-branch-aware task tracking
- **show** — Typed local/remote content references for host preview
- **tool-search** — Discover and activate tools on demand
- **web-search** — Web search
- **web-fetch** — Web page retrieval

Magenta process-backed sub-operations live inside the owning tool Source
directory. Examples: `edit/magenta/edit-hashline.toml`,
`edit/magenta/ast-edit-plan.toml`, `read/magenta/read-anchored.toml`,
`read/magenta/read-url.toml`, `find/magenta/glob.toml`,
`find/magenta/fuzzy-find.toml`, and `grep/magenta/ast-grep.toml`.
Shared code used by multiple tools lives under `HarnessComponentProtocol/_magenta/utils/<source>/`.

## Construction

Every Source `HcpMagnet.build(context)` produces a normal `AgentTool`, but the
implementation behind it varies:

- native Pi tools such as `read`, `edit`, and `ls` expose TypeBox schemas,
  execution factories, and injectable operation types through
  `@magenta/harness`;
- Magenta process-backed tools such as `lsp`, `web-search`, and `web-fetch`
  build a `ProcessTool` from a Source-local descriptor after resolving
  `runtime:process` and `sandbox`;
- host-supplied Package and MCP descriptors enter through the repository's
  `tools/descriptor` Source and still return ordinary single-product Magnets.

Schemas and product construction stay in the owning Source. TUI renderers and
interaction remain in `pi/coding-agent`.

## Native Tool API

```typescript
import {
  createReadExecute,
  createEditExecute,
  createLsExecute,
} from "@magenta/harness";
```

This factory surface applies to exported native implementations, not to every
process-backed or dynamically supplied Tool.

## HCP Declaration

Each tool has a local TOML declaration, and `HarnessComponentProtocol/harness.toml`
selects that component for codegen:

```toml
[[components]]
kind = "tool"
name = "bash"
path = "tools/bash/bash.toml"
```

Codegen projects the selected declarations into the generated `HCP_SERVERS` map
and `HCP_MAGNETS` rows consumed by `HcpClient`; it does not create another
runtime role.

See individual tool READMEs for details.
