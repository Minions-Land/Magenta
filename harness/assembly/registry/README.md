# Registry Module

The **registry** module loads and parses the harness component registry from TOML files.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `registry/pi/registry.ts`

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

**Index file** (`harness/harness.toml`):
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

The registry module includes a **minimal inline TOML parser** (no external dependencies). It supports:
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

## Registration

```toml
[[components]]
kind = "assembly"
name = "registry"
path = "registry/registry.toml"
```

## Dependencies

- Node.js `fs/promises` for file reading
- Node.js `path` for resolution

## Design Rationale

The registry is **declarative and file-based**. No code needs to change when adding components — just register them in TOML files. This enables:
- Discoverable components
- External tooling (validation, listing, code generation)
- Future dynamic loading (plugins)
