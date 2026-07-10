# Registry Infrastructure

This directory loads and parses the harness component registry from TOML files.
It is `.HCP` plumbing, not a Harness Module or Source: it owns no `HcpServer`,
`HcpMagnet`, address, contract exception, or entry in `harness.toml`.

## Implementation

- **Implementation**: TypeScript plumbing
- **Location**: `.HCP/registry/registry.ts`

## Key Exports

- `loadRegistry()` — Load the full registry from `harness.toml` and per-component TOML files
- `parseToml()` — Minimal TOML parser for declarative configuration
- `ComponentDescriptor` — Fully loaded component (index entry + parsed spec)
- `Registry` — Complete registry structure

## Usage

```typescript
import { loadRegistry } from "@magenta/harness";

const registry = await loadRegistry("/path/to/harness.toml");

console.log(registry.name);          // "magenta-harness"
console.log(registry.components);    // Array of ComponentDescriptor

for (const comp of registry.components) {
  console.log(comp.kind, comp.name); // "tool", "bash"
  console.log(comp.spec);            // Parsed TOML from bash/bash.toml
}
```

## Registry Structure

**Index file** (`HarnessComponentProtocol/harness.toml`):
```toml
name = "magenta-harness"
description = "..."

[[components]]
kind = "tool"
name = "bash"
description = "Execute shell commands"
path = "tools/bash/bash.toml"
```

**Per-component TOML** (`tools/bash/bash.toml`):
```toml
kind = "tool"
name = "bash"
description = "..."
source = "pi"

[parameters]
type = "object"
# ...
```

## TOML Parser

The registry infrastructure includes a **minimal inline TOML parser** (no external dependencies). It supports:
- `key = value` assignments
- `[section]` tables
- `[[array]]` array-of-tables
- String, boolean, integer, array literals

It is intentionally NOT a full TOML implementation — only the subset needed for declarative component registration.

## Component Discovery

1. Parse `harness.toml` to get component references
2. Resolve each component's `path` (relative to index file)
3. Load and parse each per-component TOML
4. Return typed `ComponentDescriptor` array

The returned inspection view is derived from the registered components. There
is no `core-exception`, contract component, or second Module registry. Only a
real Module/Server or Source/Magnet declared by TOML belongs in generated HCP
assembly; registry plumbing itself is never registered.

## Dependencies

- Node.js `fs/promises` for file reading
- Node.js `path` for resolution

## Design Rationale

The registry is **declarative and file-based**. Adding a component means adding
its real role files and TOML declaration, then regenerating
`.HCP/assembly/sources.generated.ts`; do not hand-maintain a second Server or
Magnet inventory. This enables:
- Discoverable components
- External tooling (validation, listing, code generation)
- Future dynamic loading (plugins)
