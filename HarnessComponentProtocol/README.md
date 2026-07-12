# HarnessComponentProtocol

This workspace contains Magenta3's Harness Modules and the Harness Component
Protocol (HCP) used to assemble them. HCP has one runtime ownership chain:

```text
HcpClient -> HcpServer -> HcpMagnet -> Tool | Capability | Resource
```

- One session owns one `HcpClient`, which performs selection and address routing.
- Every real Module owns a bare `HcpServer` in `HcpServer.ts`.
- Every declared Source owns a bare `HcpMagnet` in `HcpMagnet.ts`.
- Each returned Magnet exposes exactly one product. Resolved products execute
  directly; HCP is not middleware around every tool call.

Client, Server, and Magnet are the only HCP roles. Generated arrays, Package
declarations, MCP connections, transports, and product adapters are data or
support code, not additional roles.

## Repository Boundaries

```text
HarnessComponentProtocol/
  HcpClient.ts          session router
  harness.toml          repository component declarations
  .HCP/                 generic HCP types, assembly, and optional transport
  _magenta/             private Magenta host adapters and shared support
  <module>/             Module Server and Source Magnet implementations
  tools/                tool grouping Server and tool leaf Modules
  skills/               skill grouping Server and skill leaf Modules
```

`.HCP/` must remain host-agnostic. It consumes ordinary component inputs and
Source settings; it does not parse Package manifests, discover MCP servers, or
choose a Magenta product policy. `_magenta/` owns those host concerns and feeds
their results back through the same HcpClient assembly path. Neither directory
is itself a Harness Module, and neither may acquire an `HcpServer`.

`harness.toml` and its referenced component TOML files are the repository source
of truth. `scripts/generate-hcp-sources.mjs` validates them and regenerates
`.HCP/assembly/sources.generated.ts`, containing the disposable `HCP_SERVERS`
and `HCP_MAGNETS` projections. Never edit that generated file or maintain a
second Server map, Magnet list, or product-specific builder table.

## Package Boundary

The repository-level `../packages/` directory intentionally retains only the
generic Package integration contract and template. Concrete domain packages
are published independently on GitHub. The coding-agent host can acquire a
versioned platform archive, verify and safely extract it, and pass its cached
root into this boundary. Local integration may instead pass `packagesRoot` or
`--harness-packages-root <dir>`.

When callers omit `packagesRoot`, the support API falls back only to
`<repoRoot>/packages`. In this repository that directory contains only the
interface and template. It never searches a sibling checkout,
`MagentaPackages`, or a git submodule. `_magenta/packages/` maps declarations
from the resolved root to ordinary HcpClient inputs, so Package is not a fourth
HCP role and `.HCP/assembly/` contains no Package-specific branch.

## Development

Use package-level imports from `@magenta/harness`; application code must not
deep-import a `pi/`, `magenta/`, `_magenta/`, or `.HCP/` implementation.

From the repository root (Node.js 22.19 or newer):

```bash
npm install
npm run build
npm run check
npm test
```

For focused Harness work:

```bash
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
npm run check:assumptions -w @magenta/harness
npm run build -w @magenta/harness
npm test -w @magenta/harness
```

Read [`README-harness.md`](./README-harness.md) for the assembly walkthrough,
[`docs/DEVELOPING.md`](./docs/DEVELOPING.md) for extension workflows,
[`docs/governance/hcp-architecture.md`](./docs/governance/hcp-architecture.md)
for the authoritative architecture, and
[`docs/governance/hcp-naming.md`](./docs/governance/hcp-naming.md) for the
authoritative naming law.
