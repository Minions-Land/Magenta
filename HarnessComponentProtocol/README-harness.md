# Magenta3 Harness

**Harness** is the modular component system for Magenta3. It provides:
- Pure-execution implementations of tools, skills, compaction, prompt templates, and system prompts
- A registry-based architecture for discovering and assembling components
- Source separation: implementations organized by origin agent/source (pi, codex, claude-code, magenta, etc.)
- HCP/Magnet assembly layer for connecting components to the agent loop

## Architecture

Harness is the repository-root `HarnessComponentProtocol/` package. It contains
the component tree, HCP plumbing, and Magenta-owned foundation modules:

```
HarnessComponentProtocol/
  HcpClient.ts        — the single HCP session router
  harness.toml        — built-in component index
  .HCP/               — HCP protocol and assembly plumbing
    HcpServerTypes.ts   — Server protocol data types
    HcpMagnetTypes.ts   — Magnet product/build data types
    registry/           — registry loader
    assembly/           — component assembly (source selection)
    overlay/            — package overlay (profile/source selection)
    transport/          — injectable process/JSONL, MCP, and schema plumbing
  _magenta/           — private host/shared support code (not Modules)
    env/                — environment adapters and SSH operations
    messages/           — agent message data types and conversion
    session/            — session storage
    types/              — shared types, results, errors, ExecutionEnv
    utils/              — shared utilities
  compaction/         — branch summarization and context compaction
  context/            — context management
  hooks/              — lifecycle hooks
  memory/             — memory storage (standalone workspace package)
  multiagent/         — deterministic multi-agent orchestration
  policy/             — execution policies
  prompt-templates/   — reusable prompt templates
  runtime/            — runtime configuration
  sandbox/            — sandboxed execution
  skills/             — agent skills
  system-prompt/      — system prompt construction
  tools/              — tool implementations and tool-search support
```

MCP (Model Context Protocol) support lives in `HarnessComponentProtocol/.HCP/transport/`
(`mcp.ts` + `mcp-client.ts`): the harness connects to MCP servers and exposes
their tools as ordinary tool sources. User-configured servers are loaded from
`~/.magenta/agent/mcp-servers.json`.

### Module Layout

Every harness module follows a **standard structure** (see `scripts/templates/module/` for the full pattern):

```
HarnessComponentProtocol/<module>/
  <module>.toml      — Registration metadata
  HcpServer.ts       — Real module Server
  pi/                — Pi-sourced TypeScript implementations
    HcpMagnet.ts     — Source connector
    *.ts
  codex/             — (future) Codex-sourced implementations
  claude-code/       — (future) Claude Code-sourced implementations
  magenta/           — Magenta/Magenta1-sourced implementations
  README.md          — Per-module documentation
```

**Key principle**: Implementations are **source-separated by origin**, not by programming language or runtime protocol. The `pi/` subdirectory contains all Pi-sourced code. Magenta or Magenta1 material uses `magenta/`; Codex material should use `codex/`; Claude Code material should use `claude-code/`. A source directory may contain Rust, Python, TypeScript, binaries, manifests, and local build outputs owned by that source.

### Support Code

- `HarnessComponentProtocol/_magenta/` contains private host/shared libraries,
  not selectable Harness Modules. It has no component descriptor TOMLs and owns
  no HCP roles.
- `.HCP/` contains Client plumbing, not Modules. Its assembly, registry,
  overlay, and transport directories do not appear in `harness.toml` and own no
  Servers.

- **Tools**: Each tool is an independent module under `HarnessComponentProtocol/tools/`:
  ```
  HarnessComponentProtocol/tools/
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

The registry loader (`HarnessComponentProtocol/.HCP/registry/registry.ts`) parses these declarations at startup.

## Available Modules

### Private Support (`HarnessComponentProtocol/_magenta/`)

- **session** — Session management (jsonl/memory storage backends)
- **messages** — Agent message types and conversion utilities
- **types** — Shared types (Session, Result, errors, ExecutionEnv)
- **env** — Environment adapters (Node.js runtime integration)
- **utils** — Shared utilities (shell output formatting, truncation)

These are package implementation libraries, not entries in the Harness Module
registry.

### Capability Modules (HarnessComponentProtocol/)

- **compaction** — Branch summarization and context compaction for the agent loop
- **context** — Context management
- **hooks** — Lifecycle hooks
- **memory** — Memory storage (standalone workspace package at `@magenta/memory`)
- **multiagent** — Workflow orchestration exposed by its real module Server
- **policy** — Execution policies
- **prompt-templates** — Reusable prompt templates with parameter substitution
- **runtime** — Runtime configuration
- **sandbox** — Sandboxed execution
- **skills** — Agent skills (user-invocable via `/skill` command)
- **system-prompt** — System prompt construction and templating

### Tools (HarnessComponentProtocol/tools/)

Tools live under `HarnessComponentProtocol/tools/<tool>/`. `process` is not a tool category;
process-backed behavior is a Source implementation detail under the owning tool
directory, for example `HarnessComponentProtocol/tools/grep/magenta/`.

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
`HarnessComponentProtocol/_magenta/utils/pi/`, not under
`HarnessComponentProtocol/tools/<tool>/`.

Each tool has `<tool>.toml` at the top level. Source implementations live under
source-named subdirectories such as `pi/` or `magenta/`.

### HCP Layer (HarnessComponentProtocol/.HCP + HcpClient)

**Design principle** (from Magenta2 specs): HCP is for **management and assembly**, not the execution hot path.

- The **agent loop** calls `tool.execute()` directly (in-process, no RPC).
- **HCP data types** (`HarnessComponentProtocol/.HCP/HcpServerTypes.ts` and `HcpMagnetTypes.ts`) describe Server messages and Magnet products; they do not define role interfaces.
- **HCP client** (`HarnessComponentProtocol/HcpClient.ts`) owns module registration, address routing, and selected-instance resolution.
- **Real Servers and Magnets** live in their owning module/source folders.
  Transports live under `HarnessComponentProtocol/.HCP/transport/`; they own no
  Module or Server and register no address.
- **JSONL HCP transport** (`HcpMagnetProcess`) is injected explicitly by an
  owning source Magnet. It is not a source role and is not auto-assembled.

This separation keeps the loop fast (direct calls) while providing extensibility (discover and wire components at startup).

See `HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md` for the complete story of how these work together.

## Adding a New Component

1. **Create structure**:
   ```bash
   mkdir -p HarnessComponentProtocol/my-module/pi
   ```

2. **Write `.toml`** (`HarnessComponentProtocol/my-module/my-module.toml`):
   ```toml
   kind = "component-type"
   name = "my-module"
   description = "What it does"
   source = "pi"
   ```

3. **Implement** in `HarnessComponentProtocol/my-module/pi/*.ts`

4. **Document** in `HarnessComponentProtocol/my-module/README.md`

5. **Register** in `HarnessComponentProtocol/harness.toml`:
   ```toml
   [[components]]
   kind = "..."
   name = "my-module"
   path = "my-module/my-module.toml"
   ```

6. **Export** from `HarnessComponentProtocol/index.ts`:
   ```typescript
   export * from "./my-module/pi/my-module.js";
   ```

7. **Add the role files**: add `HarnessComponentProtocol/my-module/HcpServer.ts`
   exporting bare `class HcpServer` and
   `HarnessComponentProtocol/my-module/<source>/HcpMagnet.ts` exporting bare
   `class HcpMagnet`, then run `npm run generate:hcp-sources`. The generated
   assembly file is not hand-edited.

See `scripts/templates/module/README.md` for the complete pattern, including the
Magnet + Resource rules. For a task-oriented walkthrough (add a tool, add a
capability source, ship a package), see `docs/DEVELOPING.md`.

## Public API

Harness exports its public surface via `HarnessComponentProtocol/index.ts`. Pi
imports harness **only** at the package level:

```typescript
import { createReadExecute, AgentHarness, ... } from "@magenta/harness";
```

**Never deep-import** harness internals (e.g.,
`@magenta/harness/tools/bash/pi/bash`). The package-level barrel is the stable
API.

## Design Goals

1. **Pi owns app composition**: The `pi/` packages (coding-agent, agent-core,
   tui, ai) contain the agent loop, TUI rendering, LLM providers, and CLI. Tool
   execution logic lives in `HarnessComponentProtocol/`.

2. **Source extensibility**: When Rust, MCP, Python, or other runtime-backed implementations arrive, they slot into the origin Source directory such as `<module>/magenta/`, `<module>/codex/`, or `<module>/claude-code/`; the runtime is metadata or adapter code inside that Source, not a Source directory name.

3. **Declarative registry**: Components self-describe via TOML. The registry discovers them without hardcoded lists.

4. **Clean boundaries**: Data-type modules under `_magenta/` and `.HCP/` are
   source-agnostic. Implementation modules separate by source. Assembly layer
   (HCP) stays off the hot path.

5. **Zone clarity**: `.HCP/` owns assembly and transport plumbing,
   `_magenta/` owns package foundations, and entity-tree modules own real
   Servers and source Magnets. `.HCP/` placement does not waive the Hcp-prefix
   rule for HCP-related names.
