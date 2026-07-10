# `.HCP/` Plumbing

This directory contains HCP infrastructure that is not a fourth entity-tree
role. The only roles remain `HcpClient`, `HcpServer`, and `HcpMagnet`. HCP-related
names here still require the `Hcp` prefix; directory placement is not an escape
hatch.

- `HcpServerTypes.ts`, `HcpMagnetTypes.ts`: protocol data types only
- `assembly/`: generated Server/Magnet collection and session assembly
- `registry/`: TOML registry parsing
- `overlay/`: generic package parsing, profile selection, and source assembly;
  the external domain-package connector is deferred and this layer owns no
  package content
- `transport/`: injectable process/JSONL, MCP, and schema plumbing; it owns no
  Server or Module

The agent-facing router is `../HcpClient.ts`. Real module Servers and source
Magnets live in their owning module/source directories. No Magnet constructs a
Server, and this directory must not contain a revived `magnet/` framework.
`transport/hcp-process.ts::HcpMagnetProcess` is only an injectable JSONL
transport for an owning source; it is not auto-assembled, does not represent a
source role, and cannot register an address. Production default assembly has no
reference to it.

The sibling `../_magenta/` tree is also outside the HCP entity chain. It is
private host/shared support code, not a collection of Modules, Sources, or
contracts.

See `../docs/governance/hcp-architecture.md` and
`../docs/governance/hcp-naming.md` for the authoritative contracts.
