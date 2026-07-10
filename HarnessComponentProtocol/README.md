# HarnessComponentProtocol

This package owns Magenta3 harness components and the HCP assembly/control
plane.

## HCP Model

```text
HcpClient -> real module HcpServer -> selected source HcpMagnet -> source product
```

- `HcpClient.ts` is the one session router.
- Every actual Module owns `HcpServer.ts`.
- Every repository-declared Source owns `HcpMagnet.ts`.
- A Magnet produces exactly one Tool, Capability, or Resource.
- HCP performs assembly and management; resolved tools and capability instances
  execute directly.

There are no role interfaces, anonymous/facade Servers, per-Magnet Servers,
`toHcpServer()`, Universal Magnet, or parallel component lookup layer.
Everything related to or helping HCP carries the `Hcp` prefix, including
infrastructure under `.HCP/`; there is no directory-based escape hatch.

## Layout

```text
HarnessComponentProtocol/
  HcpClient.ts
  .HCP/                 Hcp protocol data, Client assembly, Hcp transport
  _magenta/             generic Package, MCP, host, and utility support
  compaction/           module Server + source Magnet(s)
  context/
  hooks/
  memory/
  multiagent/
  policy/
  prompt-templates/
  runtime/
  sandbox/
  skills/               root grouping Server + skill leaf Servers/Magnets
  system-prompt/
  tools/                root grouping Server + tool leaf Servers/Magnets
```

Repository component declarations start in `harness.toml` and their referenced
TOML files. Codegen projects them into `HCP_SERVERS` and `HCP_MAGNETS` in
`.HCP/assembly/sources.generated.ts`; these arrays are generated data used by
the one `HcpClient`, not another HCP role or subsystem. Package profiles are
parsed by `_magenta/packages/package-overlay.ts` and enter the same Client
assembly path. Infrastructure under `.HCP/` owns no Module or Server; dynamic
products remain under a real owning Module/Server and Source Magnet.

Magenta3 keeps the generic Package contract and template under `../packages/`.
Concrete domain packages are managed independently; callers provide their root
through the optional `packagesRoot` boundary instead of relying on a hardcoded
repository location.

## Public Use

Consumers import from the package-level barrel (`@magenta/harness`) and remain
Source-agnostic. Do not deep-import a `pi/` or `magenta/` implementation.

The authoritative contracts are:

- `docs/governance/hcp-architecture.md`
- `docs/governance/hcp-naming.md`
- `docs/DEVELOPING.md`

## Verification

```bash
npm run generate:hcp-sources -- --check
npm run check:structure
npm run build
npm test
```
