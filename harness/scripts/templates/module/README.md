# Harness Module Template

This directory provides the **standard layout template** for all harness modules.

## Standard Module Structure

Every harness module follows this pattern:

```
harness/<module-name>/
  <module-name>.toml    — Registration metadata (kind, name, description, source)
  pi/                   — Pi-sourced implementations (TypeScript)
    *.ts                — Implementation files
  magenta/              — Magenta-sourced implementations, possibly Rust/MCP-backed
  codex/                — (future) Codex-sourced implementations
  claude-code/          — (future) Claude Code-sourced implementations
  README.md             — Module documentation
```

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

## Tools Exception

Tools follow a slightly different pattern — each tool is an independent module under `tools/`:

```
harness/tools/
  <tool-name>/
    <tool-name>.toml
    pi/
      <tool-name>.ts
    README.md
```

See `tools/bash/`, `tools/edit/` etc. for examples.
