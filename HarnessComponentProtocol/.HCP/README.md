# `.HCP/`: Generic HCP Infrastructure

This directory is the host-agnostic implementation support for the three HCP
roles. It does not introduce a fourth role and is not a Harness Module.

```text
.HCP/
  HcpServerTypes.ts              Server request/response data
  HcpMagnetTypes.ts              Magnet build and product data
  assembly/session-hcp.ts        the single component construction pipeline
  assembly/sources.generated.ts  generated Server map and Magnet rows
  transport/hcp-process.ts       optional injectable JSONL transport
```

The actual router remains [`../HcpClient.ts`](../HcpClient.ts). Actual Module
Servers and Source Magnets remain beside the components they own. Code under
`.HCP/` may validate, build, route, and dispose ordinary component inputs, but
it must not know whether an input came from a Package, an MCP configuration, a
CLI flag, or another Magenta host feature.

The generated `HCP_SERVERS` and `HCP_MAGNETS` values are projections of TOML,
not entities or registries. From `HarnessComponentProtocol/`, regenerate them
with `npm run generate:hcp-sources`; never edit them or derive a parallel
selection system.

`transport/hcp-process.ts` is deliberately narrow. `HcpMagnetProcess` provides
managed JSONL request/response plumbing to a Source that explicitly injects it.
It is not the `hcp-process` Module, not a Source, not a default session
component, and not an alternative route around a Module's real `HcpServer`.

Magenta-specific Package, MCP, session, environment, and utility support belongs
under [`../_magenta/`](../_magenta/), outside this generic boundary. See the
authoritative [`HCP architecture`](../docs/governance/hcp-architecture.md) and
[`HCP naming law`](../docs/governance/hcp-naming.md).
