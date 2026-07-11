# Magenta3 Architecture

Status: current repository-level architecture as of 2026-07-11.

This document explains ownership and runtime boundaries across Magenta3. The
Harness governance documents remain authoritative for HCP behavior and naming:

- [`../HarnessComponentProtocol/docs/governance/hcp-architecture.md`](../HarnessComponentProtocol/docs/governance/hcp-architecture.md)
- [`../HarnessComponentProtocol/docs/governance/hcp-naming.md`](../HarnessComponentProtocol/docs/governance/hcp-naming.md)

## System Shape

Magenta3 is a TypeScript monorepo whose product application consumes both the
Pi foundation and the component Harness:

```text
Provider and agent foundation (pi/ai, pi/agent, pi/tui) --+
                                                          +-> Product composition
Component Harness (HarnessComponentProtocol) -------------+   (pi/coding-agent,
                                                               bin/magenta)
```

The layers are ownership boundaries, not independent applications. The coding
agent creates a session, loads resources and host inputs, asks the Harness to
assemble one HCP client, then gives resolved products to the agent loop and TUI.

## Workspace Ownership

| Workspace or path | Owns | Does not own |
|---|---|---|
| `pi/ai` | Provider adapters, model metadata, streaming APIs, model capability normalization | Sessions, tools, or Harness assembly |
| `pi/agent` | Provider-independent agent loop, messages, tool-call state, event flow | Terminal UI or filesystem implementations |
| `pi/tui` | Terminal rendering, input, components, key handling | Product commands or session policy |
| `HarnessComponentProtocol` | Harness Modules, Sources, HCP routing/assembly, generic host adapters | Product CLI/TUI composition or Package acquisition |
| `HarnessComponentProtocol/memory` | Separate memory workspace retained by the monorepo | The HCP role model |
| `pi/coding-agent` | CLI, TUI application, sessions, resource loading, auth, SSH, extensions, background work | Provider protocol internals |
| `brands` | Build-time brand metadata synchronized into package manifests | A runtime plugin system |
| `packages` | Domain Package contract documentation and a scaffold | Concrete domain Packages or a Git submodule checkout |

The root build script invokes the required workspaces explicitly in this
sequence:

```text
pi-ai
pi-agent-core
pi-tui
@magenta/harness
@magenta/memory
pi-coding-agent
```

## Runtime Flow

A normal interactive startup follows this path:

```text
bin/magenta
  -> pi/coding-agent CLI argument parsing
  -> authentication and model resolution
  -> ResourceLoader
       -> repository Harness declarations
       -> optional explicit Package inputs
       -> extensions, skills, prompts, themes
  -> HcpClient session assembly
  -> AgentSession
  -> Pi agent loop
  -> TUI rendering and tool events
```

The Harness performs construction and management. Once a Tool or live
Capability has been resolved, normal execution calls the product directly; HCP
is not middleware around every model tool call.

## HCP Entity Tree

HCP has exactly three second-level roles:

```text
HcpClient -> HcpServer -> HcpMagnet -> Tool | Capability | Resource
```

### HcpClient

`HarnessComponentProtocol/HcpClient.ts` is the session router. It owns Module
attachment, address routing, Source selection, descriptions, calls, instance
resolution, replacement, and disposal.

Session assembly constructs one `HcpClient`; it is not a process-global
singleton. Host inputs and repository defaults converge before reaching this
client rather than creating separate clients for Packages, MCP, or product
types.

### HcpServer

Every real Harness Module owns `HcpServer.ts`. A Server describes the Module's
specific routing and management behavior. Grouping Modules such as `tools` and
`skills` have real Servers, and declared leaf Modules have their own Servers.

Assembly infrastructure, Package parsing, MCP connections, and process
transport are not Modules and cannot own synthetic or facade Servers.

### HcpMagnet

Every repository-declared Source owns `HcpMagnet.ts`. A Magnet constructs and
binds one product category:

- Tool: a model-callable operation
- Capability: a live value consumed by the loop or host
- Resource: content such as skills, prompts, themes, or brand data

These product words are not extra HCP roles. There is no Capability assembler,
Package Magnet hierarchy, universal Magnet, or per-product registry.

### Declarations And Generation

Repository components are declared in
`HarnessComponentProtocol/harness.toml` and referenced component TOML files.
Codegen produces:

- `HCP_SERVERS`: real Module Server classes keyed by Module path
- `HCP_MAGNETS`: Source Magnet classes plus the static fields needed to build
  them

Both values live in
`HarnessComponentProtocol/.HCP/assembly/sources.generated.ts`. They are
rebuildable data used by `HcpClient`, not an Inventory or Registration layer.
Do not hand-edit them or maintain parallel lists.

```text
TOML declarations
  -> generate-hcp-sources.mjs
  -> HCP_SERVERS + HCP_MAGNETS
  -> HcpClientbuildsession()
  -> one HcpClient
```

## Harness Directory Boundaries

```text
HarnessComponentProtocol/
  HcpClient.ts             session router
  .HCP/
    assembly/              HcpClient assembly and generated arrays
    transport/             explicit HCP transport plumbing
    Hcp*Types.ts           role-owned protocol data
  _magenta/
    env/, mcp/, messages/, packages/, process-tools/, session/, types/, utils/
                            shared host support; not Modules or Sources
  compaction/, context/, hooks/, memory/, policy/, runtime/, sandbox/
                            capability-producing Modules
  tools/, skills/          grouping and leaf Modules
  brand/, prompt-templates/, system-prompt/, themes/
                            resource-producing Modules
```

`.HCP/` is protocol infrastructure. `_magenta/` is generic Magenta host support.
Neither directory grants an exemption from HCP naming or permission to create
another component tree.

`HcpMagnetProcess` under `.HCP/transport/` is an injectable JSONL transport
helper. It is not a Harness Module, Source, Server, or automatically assembled
component. An owning Source can explicitly use it when appropriate.

## Product Integration

### Local And Remote Workspaces

Without `--ssh`, file and shell products operate on the local current working
directory. With `--ssh user@host:path`, the coding-agent host supplies remote
operations to the same product surface. SSH is a product integration boundary,
not an HCP role or Source identity.

### MCP

User MCP configuration is read by the coding-agent host and adapted through the
real tool Module and its declared descriptor Source. Connections and shared
transport live under `_magenta/mcp`; they do not create an `mcp` Module or a
parallel tool registry.

### Domain Packages

A domain Package can describe Tools and Resources, plus Source selections for
existing Capability slots. All are mapped to the ordinary component input
shape accepted by HCP session assembly:

```text
local Package root (explicit cache or workspace packages/ fallback)
  -> _magenta Package parser/overlay
  -> HcpClient component inputs
  -> ordinary HCP assembly
```

The acquisition step is intentionally outside HCP. The future production
direction is to download, select, verify, and cache independent GitHub-hosted
Packages, then pass the resulting local root into the existing boundary. That
download pipeline is not implemented today.

An external acquisition/cache layer should pass its root explicitly. Without
one, the current compatibility behavior checks only the active workspace's
`packages/` directory. The repository root `packages/` contains only the
contract and template; Magenta3 does not scan a sibling Package checkout or
depend on a Git submodule.

### Pi Extension Resources

The `magenta install`, `remove`, `list`, `config`, and extension update commands
belong to the Pi-compatible resource manager in `pi/coding-agent`. They manage
extensions, skills, prompts, and themes referenced by settings. They do not
download or select Harness domain Packages.

## State And Configuration

The active Magenta brand sets the configuration directory name to `.magenta`.
Important machine-local paths include:

| Path | Purpose |
|---|---|
| `~/.magenta/agent/auth.json` | Stored provider credentials and OAuth state |
| `~/.magenta/agent/settings.json` | User settings and extension sources |
| `~/.magenta/agent/sessions/` | Session history |
| `~/.magenta/messages.db` | Cross-session peer-message mailbox |
| `<project>/.magenta/` | Trusted project-local settings and runtime state |

`MAGENTA_CODING_AGENT_DIR` overrides the agent directory and
`MAGENTA_CODING_AGENT_SESSION_DIR` overrides session storage. Legacy `PI_*`
variables remain where inherited Pi-compatible behavior still exposes them;
their presence does not change the Magenta storage default.

## Architectural Invariants

Changes must preserve these boundaries:

1. HCP's only roles are `HcpClient`, `HcpServer`, and `HcpMagnet`.
2. The naming hierarchy mirrors real entities; all HCP-related symbols carry
   the `Hcp` prefix.
3. TOML is the repository declaration source. Generated arrays are disposable
   projections and are never edited as a second truth.
4. All static and host-supplied products converge on one session assembly path.
5. Capability and built-in may describe behavior in local contexts, but neither
   may become a parallel HCP architecture or selection system.
6. `_magenta/` and `.HCP/` contain support infrastructure, not hidden Modules.
7. Domain Package acquisition remains outside HCP and outside the root Package
   contract directory.
8. `pi/coding-agent` consumes Harness package-level APIs and owns product
   composition.

## Verification

Architectural changes require more than TypeScript compilation:

```bash
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
npm test -w @magenta/harness
npm run build
npm run check
npm test
```

Changes to user-visible workflows should also run the applicable CLI/TUI
end-to-end project from [`../tests/README.md`](../tests/README.md).
