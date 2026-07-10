# HarnessComponentProtocol

This package owns Magenta3 harness components and the HCP assembly/control
plane.

## HCP Model

```text
HcpClient -> real module HcpServer -> selected source HcpMagnet -> source product
```

- `HcpClient.ts` is the one session router.
- Every actual module owns `HcpServer.ts`.
- Every built-in source owns `HcpMagnet.ts`.
- A Magnet produces exactly one Tool, Capability, or Resource.
- HCP performs assembly and management; resolved tools and capability instances
  execute directly.

There are no role interfaces, anonymous/facade Servers, per-Magnet Servers,
`toHcpServer()`, Universal Magnet, or parallel source registry.
Everything related to or helping HCP carries the `Hcp` prefix, including
infrastructure under `.HCP/`; there is no directory-based escape hatch.

## Layout

```text
HarnessComponentProtocol/
  HcpClient.ts
  .HCP/                 protocol data, assembly, registry, overlay, transport
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

Built-in collection is generated from `harness.toml` and registered component
TOML files into `.HCP/assembly/sources.generated.ts`. Package profiles and
sources are assembled by `.HCP/overlay/`. Infrastructure under `.HCP/` owns no
Module or Server; dynamic products remain under a real owning Module/Server and
source Magnet.

## Public Use

Consumers import from the package-level barrel (`@magenta/harness`) and remain
source-agnostic. Do not deep-import a `pi/` or `magenta/` implementation.

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
