# Magenta3 Harness

`HarnessComponentProtocol/` owns Magenta3's harness components and the HCP
assembly path. Runtime HCP has exactly three roles:

```text
HcpClient -> real module HcpServer -> selected source HcpMagnet -> product
```

- The one session `HcpClient` owns selection, addresses, and routing.
- Every actual Module owns a bare `HcpServer` in `HcpServer.ts`.
- Every declared Source owns a bare `HcpMagnet` in `HcpMagnet.ts`.
- A Magnet produces exactly one Tool, Capability, or Resource.
- Once assembled, tools and live capability values execute directly; HCP is not
  the agent loop's execution middleware.

There is no fourth HCP role, role interface, contract layer, parallel selection
layer, or transport-owned Module. Names and paths must follow
`docs/governance/hcp-naming.md`.

## Layout

```text
HarnessComponentProtocol/
  HcpClient.ts          one session router
  harness.toml          repository component declarations
  .HCP/
    HcpServerTypes.ts   Server protocol data
    HcpMagnetTypes.ts   Magnet build and product data
    assembly/           generated declarations and session assembly
    transport/          injectable HcpMagnet process/JSONL plumbing
  _magenta/
    mcp/                 generic MCP client, cache, schema, and Tool product support
    packages/            generic Package discovery and overlay support
    ...                  private host/shared support, including generic TOML parsing
  <module>/
    <module>.toml
    HcpServer.ts
    <source>/
      HcpMagnet.ts
      ...source-owned implementation
  tools/
    HcpServer.ts
    <tool>/
      <tool>.toml
      HcpServer.ts
      <source>/HcpMagnet.ts
```

`_magenta/` contains session, environment, message, type, and utility support.
`.HCP/` contains protocol plumbing. Neither tree is a collection of Harness
Modules, and neither can own an `HcpServer` or an address.

Tools and skills retain both ownership levels: the root grouping Module and
each declared leaf have real Servers. A nested Source may be deeper when the
declared implementation path requires it, such as
`multiagent/workflow/magenta/HcpMagnet.ts`.

## Declarations And Assembly

`harness.toml` points to repository component TOML files:

```toml
[[components]]
kind = "tool"
name = "bash"
description = "Execute shell commands."
path = "tools/bash/bash.toml"
```

`scripts/generate-hcp-sources.mjs` validates these declarations and role files,
then writes `.HCP/assembly/sources.generated.ts`:

- `HCP_SERVERS` maps Module paths to real `HcpServer` classes.
- `HCP_MAGNETS` contains Source `HcpMagnet` classes and the static data needed
  to select and build them.

These generated values are disposable projections of TOML, not additional HCP
entities. Do not hand-edit the generated file, add product-specific Magnet
lists, or add central Source switches. Session assembly selects entries, calls
`HcpMagnet.build()`, and attaches each result to its real Server through the one
`HcpClient`.

Source names describe origin, such as `pi`, `magenta`, `codex`, or
`claude-code`. Process, Python, Rust, MCP, and JSONL are implementation or
transport mechanisms inside an owning Source; they are never Source names or
HCP roles.

## Products And Transport

A source `HcpMagnet` produces one of:

| Product | Result | Runtime use |
|---|---|---|
| Tool | `AgentTool` | agent loop calls `execute()` |
| Capability | `HcpMagnetBinding.instance` | host calls the live slot value |
| Resource | `HcpMagnetResource` | resource loader merges content |

`ProcessTool`, `PythonModuleTool`, and `McpTool` are product adapters.
`.HCP/transport/hcp-process.ts::HcpMagnetProcess` is optional JSONL plumbing an
owning Source may explicitly inject. It is not a Module, is not generated as a
Source Magnet, owns no Server, and is absent from default session assembly.

## Package Boundary

Magenta3 intentionally retains the generic Package boundary:

```text
packages/
  README.md
  templates/harness-package/
```

Concrete domain expert packages are independently managed and versioned outside
this repository, including in `MagentaPackages`. The support API in
`_magenta/packages/package-overlay.ts` parses Package manifests, profiles,
resources, and tool descriptors. `discoverHarnessPackages()` and `loadPackageOverlay()`
accept an optional `packagesRoot`, so an integration can supply an external root
without hardcoding or implicitly scanning a sibling repository.

Package components join the same HcpClient assembly path. The Package overlay is
not a Module, Source, product category, or second selection system. Package
paths remain relative to the explicitly supplied Package root.

## Adding A Component

For a repository component:

1. Add its descriptor TOML and owning `<module>/HcpServer.ts`.
2. Add `<module>/<source>/HcpMagnet.ts` and the Source implementation.
3. Reference the descriptor from `harness.toml`.
4. Export only the Source-independent public product from `index.ts` when a
   public API is needed.
5. Run `npm run generate:hcp-sources`; never edit
   `sources.generated.ts` directly.

For detailed Tool, capability-slot, Resource, and Package workflows, see
`docs/DEVELOPING.md`.

## Public API

Consumers use the package-level `@magenta/harness` API. They must not deep-import
`pi/`, `magenta/`, or `.HCP/` internals and must not choose Source-specific
implementations directly.

## Verification

From `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure
npm run build
npm test
```

The authoritative contracts are:

- `docs/governance/hcp-architecture.md`
- `docs/governance/hcp-naming.md`
- `docs/DEVELOPING.md`
