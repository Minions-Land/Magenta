# Magenta3 Harness

**Harness** is the modular component system for Magenta3. It provides:
- Pure-execution implementations of tools, skills, compaction, prompt templates, and system prompts
- A registry-based architecture for discovering and assembling components
- Source separation: implementations organized by origin agent/source (pi, codex, claude-code, magenta, etc.)
- HCP/Magnet assembly layer for connecting components to the agent loop

## Architecture

### Module Layout

Every harness module follows a **standard structure** (see `template/` for the full pattern):

```
harness/<module>/
  <module>.toml      — Registration metadata
  pi/                — Pi-sourced TypeScript implementations
    *.ts
  codex/             — (future) Codex-sourced implementations
  claude-code/       — (future) Claude Code-sourced implementations
  magenta/           — Magenta/Magenta1-sourced implementations
  README.md          — Per-module documentation
```

**Key principle**: Implementations are **source-separated by origin**, not by programming language or runtime protocol. The `pi/` subdirectory contains all Pi-sourced code. Magenta or Magenta1 material uses `magenta/`; Codex material should use `codex/`; Claude Code material should use `claude-code/`. A source directory may contain Rust, Python, TypeScript, binaries, manifests, and local build outputs owned by that source.

### Special Cases

- **Contract modules** (`messages/`, `types/`): Pure type definitions with no implementations. These stay flat (no source subdirectories) since they define shared contracts across all sources.

- **Tools**: Each tool is an independent module under `tools/`:
  ```
  tools/
    bash/
      bash.toml
      pi/bash.ts
      README.md
    edit/
      edit.toml
      pi/edit.ts
      README.md
    ...
  ```

### Component Registry

All components register via TOML files indexed in `harness.toml`:

```toml
[[components]]
kind = "tool"
name = "bash"
description = "Execute shell commands"
path = "tools/bash/bash.toml"
```

The registry loader (`registry/pi/registry.ts`) parses these declarations at startup.

Catalog inventories use a separate `[[catalogs]]` section. A catalog is not a
loop-ready implementation; it is selector metadata for migrated or candidate
components. The Magenta1 `general-harness` inventory is registered this way so
selection UI can display all 111 historical components with provenance while
Magenta3 only registers currently assembled implementations under
`[[components]]`.

## Available Modules

### Implementation Modules (have pi/ subdirectory)

- **compaction** — Branch summarization and context compaction for the agent loop
- **prompt-templates** — Reusable prompt templates with parameter substitution
- **skills** — Agent skills (user-invocable via `/skill` command)
- **system-prompt** — System prompt construction and templating
- **loop** — Agent harness (main loop orchestration)
- **session** — Session management (jsonl/memory storage backends)
- **env** — Environment adapters (Node.js runtime integration)
- **utils** — Shared utilities (shell output formatting, truncation)
- **catalog** — Component inventories and integration maps for selector UIs

### Assembly Layer

- **hcp** — Harness Component Protocol (management/discovery, NOT on the hot path)
- **magnet** — Connectors that wrap implementations as AgentTools or HCP targets
- **registry** — TOML registry loader and component discovery

See `assembly/README.md` for the complete story of how these work together.

### Contract Modules (flat, no pi/)

- **messages** — Agent message types and utilities
- **types** — Shared types across harness (Session, Result, errors, etc.)

### Tools

Tools live directly under `tools/<tool>/`. `process` is not a tool category;
process-backed behavior is a Source implementation detail under the owning tool
directory, for example `tools/grep/magenta/`.

Core Pi-backed tools:
- **bash** — Shell command execution
- **edit** — File editing with exact text replacement
- **grep** — Pattern search in files
- **read** — Read file contents
- **write** — Write file contents
- **find** — Find files by glob pattern
- **ls** — List directory entries

Some Magenta-backed implementations expose sub-operations under an owning tool
slot instead of becoming their own top-level tool module. For example,
`edit/magenta/` owns `edit-hashline` and `ast-edit-plan`, `read/magenta/` owns
`read-anchored` and `read-url`, `find/magenta/` owns `glob` and `fuzzy-find`,
and `grep/magenta/` owns `ast-grep`. Shared tool utilities live under
`utils/pi/`, not under `tools/`.

Each tool has `<tool>.toml` at the top level. Source implementations live under
source-named subdirectories such as `pi/` or `magenta/`.

## HCP / Magnet / Registry

**Design principle** (from Magenta2 specs): HCP is for **management and assembly**, not the execution hot path.

- The **agent loop** calls `tool.execute()` directly (in-process, no RPC).
- **HCP** provides discovery, configuration, and lifecycle management.
- **Magnet** wraps implementations into the `AgentTool` contract the loop consumes.
- **Registry** loads component metadata from TOML files.

This separation keeps the loop fast (direct calls) while providing extensibility (discover and wire components at startup).

## Adding a New Component

1. **Create structure**:
   ```bash
   mkdir -p harness/my-module/pi
   ```

2. **Write `.toml`** (`harness/my-module/my-module.toml`):
   ```toml
   kind = "component-type"
   name = "my-module"
   description = "What it does"
   source = "pi"
   ```

3. **Implement** in `harness/my-module/pi/*.ts`

4. **Document** in `harness/my-module/README.md`

5. **Register** in `harness/harness.toml`:
   ```toml
   [[components]]
   kind = "..."
   name = "my-module"
   path = "my-module/my-module.toml"
   ```

6. **Export** from `harness/index.ts`:
   ```typescript
   export * from "./my-module/pi/my-module.js";
   ```

See `template/README.md` for the complete pattern.

## Public API

Harness exports all module implementations via `harness/index.ts`. Pi imports harness **only** at the package level:

```typescript
import { createReadExecute, AgentHarness, ... } from "@magenta/harness";
```

**Never deep-import** harness internals (e.g., `@magenta/harness/tools/bash/pi/bash`). The package-level barrel is the stable API.

## Design Goals

1. **PI holds only abstractions**: The `pi/` packages (coding-agent, agent-core, tui, ai) contain the agent loop, TUI rendering, LLM providers, and CLI. Tool *execution logic* lives in harness.

2. **Source extensibility**: When Rust, MCP, Python, or other runtime-backed implementations arrive, they slot into the origin Source directory such as `<module>/magenta/`, `<module>/codex/`, or `<module>/claude-code/`; the runtime is metadata or adapter code inside that Source, not a Source directory name.

3. **Declarative registry**: Components self-describe via TOML. The registry discovers them without hardcoded lists.

4. **Clean boundaries**: Contract modules (types, messages) are source-agnostic. Implementation modules separate by source. Assembly layer (HCP/Magnet) stays off the hot path.

See `docs/specs/2026-06-30-harness-reorg.md` for the full design rationale.
