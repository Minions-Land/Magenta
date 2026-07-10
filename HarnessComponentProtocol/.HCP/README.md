# `.HCP/` Plumbing

This directory contains HCP infrastructure that is not a fourth entity-tree
role. The only roles remain `HcpClient`, `HcpServer`, and `HcpMagnet`. HCP-related
names here still require the `Hcp` prefix; directory placement is not an escape
hatch.

- `HcpServerTypes.ts`, `HcpMagnetTypes.ts`: protocol data types only
- `assembly/`: generated Server/Magnet declarations and session assembly
- `transport/`: explicitly HCP-owned process/JSONL plumbing; it owns no Server
  or Module

There is no separate discovery or ownership subsystem under `.HCP/`.
Repository component declarations are projected by codegen into `HCP_SERVERS`
and `HCP_MAGNETS`, which the one `../HcpClient.ts` consumes directly.

The agent-facing router is `../HcpClient.ts`. Real Module Servers and Source
Magnets live in their owning Module/Source directories. No Magnet constructs a
Server, and this directory must not contain a revived `magnet/` framework.
`transport/hcp-process.ts::HcpMagnetProcess` is only an injectable JSONL
transport for an owning Source; it is not auto-assembled, does not represent a
Source role, and cannot own an address. Production default assembly has no
reference to it.

The sibling `../_magenta/` tree is outside the HCP entity chain. It contains
private host/shared support code, including generic Package integration under
`../_magenta/packages/`, MCP support under `../_magenta/mcp/`, and TOML parsing
under `../_magenta/utils/`. These are not Modules, Sources, contracts, or HCP
selection layers.

See `../docs/governance/hcp-architecture.md` and
`../docs/governance/hcp-naming.md` for the authoritative contracts.
