# Tools Module

The **tools** module provides pure-execution implementations of agent tools.

## Structure

Each tool is an independent module under `tools/`:

```
tools/
  bash/
    bash.toml      — Tool registration
    pi/bash.ts     — Pi implementation
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

## Shared Support

`tools/support/` contains shared utilities used by multiple tools:
- `edit-diff.ts` — Diff computation for edit tool
- `truncate.ts` — Output truncation
- `path-utils.ts` — Path resolution
- `file-mutation-queue.ts` — Serialized file writes
- `output-accumulator.ts` — Streaming output collection

## Design

Each tool exports:
- **Schema** (`<tool>Schema`) — TypeBox parameter schema
- **Execute factory** (`create<Tool>Execute`) — Pure execution function
- **Operations interface** — Injectable filesystem/exec operations (for testing)
- **Types** — Input/Output/Options types

The pi packages consume these via `@magenta/harness` and wrap them with rendering (TUI) to produce `ToolDefinition` objects for the agent loop.

## Public API

```typescript
import {
  createBashExecute,
  createReadExecute,
  createEditExecute,
  // ...
} from "@magenta/harness";
```

## Registration

Each tool registers individually in `harness/harness.toml`:
```toml
[[components]]
kind = "tool"
name = "bash"
path = "tools/bash/bash.toml"
```

See individual tool READMEs for details.
