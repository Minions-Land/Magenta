# Magenta3 Harness

**Harness** is the modular component system for Magenta3. It provides:
- Pure-execution implementations of tools, skills, compaction, prompt templates, and system prompts
- A registry-based architecture for discovering and assembling components
- Source separation: implementations organized by origin agent/source (pi, codex, claude-code, magenta, etc.)
- HCP/Magnet assembly layer for connecting components to the agent loop

## Architecture

Harness is organized into **five zones** plus registry infrastructure:

```
harness/
  hcp-contract/     — HCP protocol contract (server + magnet interfaces)
  hcp-client/       — HCP client (registry, assembly, package overlay)
  hcp-magnet/       — Magnet connectors (wrap implementations as AgentTools/HcpServers)
  
  modules/          — Capability and tool modules (13 modules)
    compaction/       — Branch summarization and context compaction
    context/          — Context management
    hooks/            — Lifecycle hooks
    memory/           — Memory storage (standalone workspace package)
    multiagent/       — Deterministic multi-agent orchestration (consumed by sub_agent; not a harness.toml component)
    policy/           — Execution policies
    prompt-templates/ — Reusable prompt templates
    runtime/          — Runtime configuration
    sandbox/          — Sandboxed execution
    skills/           — Agent skills (user-invocable via /skill)
    system-prompt/    — System prompt construction
    tools/            — Tool implementations (bash, edit, grep, read, write, etc.)
    tools-search/     — Tool search and discovery
  
  core/             — Core runtime (6 modules)
    env/              — Environment adapters (Node.js runtime integration)
    loop/             — Agent harness (main loop orchestration)
    messages/         — Agent message types and conversion utilities
    session/          — Session management (jsonl/memory storage backends)
    types/            — Shared types (Session, Result, errors, ExecutionEnv)
    utils/            — Shared utilities (shell output, truncation)
  
  catalog/          — Component inventories and integration maps
```

MCP (Model Context Protocol) support lives in `hcp-magnet/` (`mcp.ts` +
`mcp-client.ts`): the harness connects to MCP servers and exposes their tools
as magnets. User-configured servers are loaded from `~/.magenta/agent/mcp-servers.json`.

### Module Layout

Every harness module follows a **standard structure** (see `scripts/templates/module/` for the full pattern):

```
modules/<module>/
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

- **Contract modules** (`core/messages/`, `core/types/`, `hcp-contract/`): Pure type definitions with no implementations. These stay flat (no source subdirectories) since they define shared contracts across all sources.

- **Tools**: Each tool is an independent module under `modules/tools/`:
  ```
  modules/tools/
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
path = "modules/tools/bash/bash.toml"
```

The registry loader (`hcp-client/registry/registry.ts`) parses these declarations at startup.

Catalog inventories use a separate `[[catalogs]]` section. A catalog is not a
loop-ready implementation; it is selector metadata for migrated or candidate
components. The Magenta1 `general-harness` inventory is registered this way so
selection UI can display all 111 historical components with provenance while
Magenta3 only registers currently assembled implementations under
`[[components]]`.

## Available Modules

### Core Runtime (core/)

- **loop** — Agent harness (main loop orchestration)
- **session** — Session management (jsonl/memory storage backends)
- **messages** — Agent message types and conversion utilities
- **types** — Shared types (Session, Result, errors, ExecutionEnv)
- **env** — Environment adapters (Node.js runtime integration)
- **utils** — Shared utilities (shell output formatting, truncation)

### Capability Modules (modules/)

- **compaction** — Branch summarization and context compaction for the agent loop
- **context** — Context management
- **hooks** — Lifecycle hooks
- **memory** — Memory storage (standalone workspace package at `@magenta/memory`)
- **multiagent** — Workflow orchestration engine: load a workflow module, inject primitives, run it. Six presets + user scripts, single execution path (consumed directly by the `sub_agent` tool via import)
- **policy** — Execution policies
- **prompt-templates** — Reusable prompt templates with parameter substitution
- **runtime** — Runtime configuration
- **sandbox** — Sandboxed execution
- **skills** — Agent skills (user-invocable via `/skill` command)
- **system-prompt** — System prompt construction and templating
- **tools-search** — Tool search and discovery

> **Note:** `multiagent` and `tools-search` are intentionally **not** registered as
> loop components in `harness.toml`. `multiagent` is consumed directly by the
> `sub_agent` tool via import (it is a workflow engine, not a loop capability), and
> `tools-search` is wired separately. The other 11 modules are `harness.toml` components.

### Tools (modules/tools/)

Tools live under `modules/tools/<tool>/`. `process` is not a tool category;
process-backed behavior is a Source implementation detail under the owning tool
directory, for example `modules/tools/grep/magenta/`.

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
`core/utils/pi/`, not under `modules/tools/`.

Each tool has `<tool>.toml` at the top level. Source implementations live under
source-named subdirectories such as `pi/` or `magenta/`.

### HCP Layer (hcp-contract, hcp-client, hcp-magnet)

**Design principle** (from Magenta2 specs): HCP is for **management and assembly**, not the execution hot path.

- The **agent loop** calls `tool.execute()` directly (in-process, no RPC).
- **HCP contract** (`hcp-contract/`) defines the server and magnet interfaces.
- **HCP client** (`hcp-client/`) provides the registry loader, component assembly, and package overlay (profile/source selection).
- **HCP magnet** (`hcp-magnet/`) wraps implementations into the `AgentTool` contract the loop consumes.

This separation keeps the loop fast (direct calls) while providing extensibility (discover and wire components at startup).

See `hcp-client/HCP-OVERVIEW.md` for the complete story of how these work together.

### Catalog (catalog/)

The catalog provides component inventories and integration maps for selector UIs. It's registry infrastructure, not a capability module. The Magenta1 `general-harness` inventory lives here.

## Adding a New Component

1. **Create structure**:
   ```bash
   mkdir -p harness/modules/my-module/pi
   ```

2. **Write `.toml`** (`harness/modules/my-module/my-module.toml`):
   ```toml
   kind = "component-type"
   name = "my-module"
   description = "What it does"
   source = "pi"
   ```

3. **Implement** in `harness/modules/my-module/pi/*.ts`

4. **Document** in `harness/modules/my-module/README.md`

5. **Register** in `harness/harness.toml`:
   ```toml
   [[components]]
   kind = "..."
   name = "my-module"
   path = "modules/my-module/my-module.toml"
   ```

6. **Export** from `harness/index.ts`:
   ```typescript
   export * from "./modules/my-module/pi/my-module.js";
   ```

7. **Bind a Magnet** (capability modules only): add
   `modules/my-module/<source>/magnet.ts` exporting a `CapabilitySourceMagnet` and
   register it in the barrel `hcp-client/assembly/sources.ts`. Tools and Resources
   (e.g. `system-prompt`) do not use a capability magnet.

See `scripts/templates/module/README.md` for the complete pattern, including the
Magnet + Resource rules. For a task-oriented walkthrough (add a tool, add a
capability source, ship a package), see `docs/DEVELOPING.md`.

## Public API

Harness exports all module implementations via `harness/index.ts`. Pi imports harness **only** at the package level:

```typescript
import { createReadExecute, AgentHarness, ... } from "@magenta/harness";
```

**Never deep-import** harness internals (e.g., `@magenta/harness/modules/tools/bash/pi/bash`). The package-level barrel is the stable API.

## Design Goals

1. **Pi holds only abstractions**: The `pi/` packages (coding-agent, agent-core, tui, ai) contain the agent loop, TUI rendering, LLM providers, and CLI. Tool *execution logic* lives in harness.

2. **Source extensibility**: When Rust, MCP, Python, or other runtime-backed implementations arrive, they slot into the origin Source directory such as `<module>/magenta/`, `<module>/codex/`, or `<module>/claude-code/`; the runtime is metadata or adapter code inside that Source, not a Source directory name.

3. **Declarative registry**: Components self-describe via TOML. The registry discovers them without hardcoded lists.

4. **Clean boundaries**: Contract modules (core/types/, core/messages/, hcp-contract/) are source-agnostic. Implementation modules separate by source. Assembly layer (HCP) stays off the hot path.

5. **Zone clarity**: The five-zone layout (hcp-contract, hcp-client, hcp-magnet, modules, core) makes responsibility and dependency flow explicit. Core runtime is foundational, modules are pluggable capabilities, HCP is the assembly layer.
