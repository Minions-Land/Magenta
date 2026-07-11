# Magenta3

Magenta3 is a terminal-native coding agent for sustained software work. It
combines an interactive TUI, non-interactive CLI, model/provider selection,
local and SSH workspaces, background jobs, sub-agents, peer messaging, and a
component Harness assembled through HCP.

Magenta3 builds on a vendored Pi foundation. Pi supplies the agent loop, model
APIs, session machinery, and terminal UI; Magenta adds the Harness, branded
command and storage, remote execution, multi-agent workflows, and product
integration.

> The upstream Pi README is preserved at
> [`pi/README-upstream.md`](./pi/README-upstream.md). This README describes the
> Magenta3 repository as it exists now.

## Requirements

- Node.js `22.19.0` or newer
- npm
- Provider credentials for live model calls
- A terminal with TTY support for the interactive UI
- Optional: Bun for standalone binary builds

## Build And Run

From the repository root:

```bash
npm install
npm run build
./bin/magenta
```

`./bin/magenta` starts the built Node.js CLI at
`pi/coding-agent/dist/cli.js`. Rebuild after changing TypeScript source.

Useful startup commands:

```bash
# Interactive TUI
./bin/magenta

# Interactive TUI with an initial request
./bin/magenta "Review this repository"

# One-shot text output
./bin/magenta --print --no-session "Summarize package.json"

# JSON event stream
./bin/magenta --mode json --print --no-session "List changed files"

# Select provider, model, and reasoning level
./bin/magenta --provider openai --model gpt-5.6-sol --thinking max

# Work against a remote checkout
./bin/magenta --ssh user@host:/srv/project

# Show every supported option
./bin/magenta --help
```

Reasoning levels are model-dependent. The CLI accepts `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`, then exposes only the levels supported by
the selected model. `ultra` is not a Magenta reasoning level.

## Authentication

The simplest setup is either an environment variable or `/login` in the TUI:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...

./bin/magenta
```

Magenta also reads compatible Claude Code settings and Codex credentials.
Stored login state lives at `~/.magenta/agent/auth.json`. See
[`docs/AUTHENTICATION.md`](./docs/AUTHENTICATION.md) for the exact lookup order
and supported paths.

## What Is Included

| Area | Current behavior |
|---|---|
| Coding workflow | Streaming TUI, session history, forks, compaction, exports, and model switching |
| Workspace tools | Read, write, edit, bash, grep, find, list, show, LSP, web access, and tool discovery |
| Background work | Long-running shell jobs, independent sub-agents, and event inspection |
| Multi-agent work | Headless delegation, deterministic workflows, and cross-session peer messages |
| Remote work | `--ssh` redirects supported file and shell operations to a remote checkout |
| Model layer | OpenAI, Anthropic, Google, OpenRouter, Bedrock, and other providers exposed by `pi/ai` |
| Harness | Repository and externally supplied components assembled through one HCP path |
| Extensions | Pi-compatible extensions, skills, prompt templates, and themes |
| State | Magenta-owned configuration and sessions under `~/.magenta/` |

Common TUI commands include:

| Command | Purpose |
|---|---|
| `/model` | Select a model and supported reasoning level |
| `/scoped-models` | Configure models used by `Ctrl+P` cycling |
| `/harness` | Inspect and switch Harness-backed runtime selections |
| `/mcp` | Manage user MCP server configuration |
| `/settings` | Edit application settings |
| `/events` | Inspect background work started by the main agent |
| `/session`, `/resume`, `/fork`, `/tree` | Inspect or navigate session history |
| `/compact` | Compact the active context |
| `/login`, `/logout` | Manage stored provider authentication |
| `/refresh` | Refresh extensions, skills, prompts, themes, and keybindings |
| `/reload` | Recompile and restart while retaining the current session |

Type `/` in the TUI for the authoritative command list.

### Common CLI Workflows

```bash
# Sessions
./bin/magenta --continue
./bin/magenta --resume
./bin/magenta --session <path-or-id>
./bin/magenta --fork <path-or-id>
./bin/magenta --name "Review HCP"

# Models
./bin/magenta --list-models gpt-5.6
./bin/magenta --models "openai/gpt-5.6-sol:max,anthropic/*opus*:high"

# Pi-compatible extension resources
./bin/magenta install npm:@scope/package
./bin/magenta list
./bin/magenta config
./bin/magenta update --extensions
./bin/magenta remove npm:@scope/package

# Harness inspection
./bin/magenta --harness-list
```

Use `./bin/magenta install --help`, `remove --help`, `update --help`, or
`list --help` before changing extension sources. `config` opens its interactive
resource selector directly. Harness domain Package selection uses the separate
explicit-root flags described under [Package Boundary](#package-boundary).

## Architecture

The product composes two implementation layers:

```text
pi/ai + pi/agent + pi/tui -----------+
                                      +-> pi/coding-agent -> bin/magenta
HarnessComponentProtocol/ -----------+
```

- `pi/` is the vendored foundation: provider APIs, the agent loop, the terminal
  UI library, and the coding-agent application.
- `HarnessComponentProtocol/` owns Harness modules and HCP assembly.
- `pi/coding-agent/` composes the product and owns CLI/TUI integration.
- `brands/` supplies build-time product metadata.
- `packages/` retains only the domain Package integration contract and a
  template. It does not contain concrete domain packages.

### HCP In One Chain

HCP has exactly three runtime roles:

```text
HcpClient -> module HcpServer -> source HcpMagnet -> product
```

- `HcpClient` is the single session router and assembly owner.
- Each real Module owns an `HcpServer`.
- Each declared Source owns an `HcpMagnet` that produces one Tool, Capability,
  or Resource.

Tool, Capability, and Resource describe Magnet products; they are not extra HCP
roles. Similarly, configuration, generated arrays, Package loading, MCP, and
transport support do not form parallel registries or additional HCP layers.

Repository declarations flow in one direction:

```text
harness.toml and component TOML
  -> generated HCP_SERVERS and HCP_MAGNETS
  -> session assembly
  -> HcpClient
```

The generated values are rebuildable projections of TOML, not a separate
inventory or registration architecture. The complete architecture and naming
rules are authoritative in:

- [`HarnessComponentProtocol/docs/governance/hcp-architecture.md`](./HarnessComponentProtocol/docs/governance/hcp-architecture.md)
- [`HarnessComponentProtocol/docs/governance/hcp-naming.md`](./HarnessComponentProtocol/docs/governance/hcp-naming.md)

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for repository-level
ownership and dependency details.

## Package Boundary

Two different mechanisms use the word "package" and must not be confused:

1. `magenta install`, `remove`, `list`, and `config` manage Pi-compatible
   extension resources.
2. A Harness domain Package is an external bundle mapped into ordinary HCP
   component inputs.

Concrete domain Packages are managed outside this repository and will
eventually be downloaded from GitHub. That acquisition, version selection,
verification, and caching flow is not implemented yet. The current loader only
consumes Packages already present on disk. An external cache should be passed
explicitly:

```bash
./bin/magenta \
  --harness-packages-root /absolute/path/to/packages \
  --harness-package <selector>
```

Without `--harness-packages-root`, the compatibility fallback checks only
`<current-workspace>/packages`. The root [`packages/`](./packages/) directory
remains intentionally small: it documents the integration contract and
supplies a template. No sibling checkout or Git submodule is scanned or
assumed.

## Repository Layout

```text
Magenta3/
  bin/                         local launchers
  brands/                      build-time brand registry
  docs/                        repository documentation
  HarnessComponentProtocol/   Harness modules and HCP
    .HCP/                      HCP protocol, assembly, and HCP transport
    _magenta/                  host/shared support; not Harness Modules
    tools/, skills/, ...       real Module and Source trees
  packages/                    domain Package contract and template only
  pi/
    ai/                        model and provider layer
    agent/                     core agent loop
    tui/                       terminal UI library
    coding-agent/              Magenta CLI/TUI application
  scripts/                     build, release, and repository checks
  tests/e2e/                   real CLI/TUI process tests
```

## Development

Common repository commands:

```bash
# Build all required workspaces
npm run build

# Run all workspace tests that define a test script
npm test

# Apply formatting and run repository static checks
npm run check

# Focused workspace tests
npm test -w @magenta/harness
npm test -w @earendil-works/pi-ai
npm test -w @earendil-works/pi-coding-agent
npm test -w @earendil-works/pi-tui

# Verify generated HCP assembly and entity-tree structure
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
```

`npm run check` invokes Biome with `--write`, so it can modify formatting.
Review its diff before committing.

End-to-end tests drive the built product:

```bash
npm run build
npx playwright test --project lazypi-tests
npx playwright test --project tui-tests
npx playwright test --project cli-conversation
```

The TUI and conversation projects make real provider calls and require working
credentials. See [`tests/README.md`](./tests/README.md).

Before changing Harness structure, read the frozen naming rules and the live
governance documents. Do not introduce a fourth HCP role, a parallel assembly
path, or a hand-maintained list beside `HCP_SERVERS` and `HCP_MAGNETS`.

The full contribution workflow is in
[`docs/DEVELOPING.md`](./docs/DEVELOPING.md).

## Documentation

- [`docs/README.md`](./docs/README.md): documentation index
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md): repository architecture
- [`docs/DEVELOPING.md`](./docs/DEVELOPING.md): development and contribution
- [`docs/AUTHENTICATION.md`](./docs/AUTHENTICATION.md): provider credentials
- [`docs/BRANDING.md`](./docs/BRANDING.md): build-time brand registry
- [`HarnessComponentProtocol/README.md`](./HarnessComponentProtocol/README.md): Harness overview
- [`HarnessComponentProtocol/docs/DEVELOPING.md`](./HarnessComponentProtocol/docs/DEVELOPING.md): adding Harness components
- [`packages/README.md`](./packages/README.md): domain Package boundary

Licensing is declared by the individual workspace packages.
