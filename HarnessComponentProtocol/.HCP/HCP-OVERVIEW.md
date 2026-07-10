# HCP Overview

HCP assembles selectable harness components through one ownership chain:

```text
HcpClient -> real module HcpServer -> selected source HcpMagnet -> source product
```

The authoritative contract is `../docs/governance/hcp-architecture.md`; naming
is authoritative in `../docs/governance/hcp-naming.md`.

## Responsibilities

### HcpClient

`../HcpClient.ts` is the single session router. Assembly registers a real module
Server and its selector-to-Magnet slots with `registerModule()`. The Client owns
address routing, source selection, descriptions, calls, and instance
resolution.

### HcpServer

Each module owns a real `HcpServer.ts`. Leaf modules such as `tools/read` and
grouping modules such as `tools` or `skills` are explicit entities.
Tools and skills therefore keep both layers: the root grouping Server and every
registered leaf's own Server.

Assembly does not synthesize anonymous, facade, or per-Magnet Servers.
Infrastructure directories (`assembly`, `registry`, `overlay`, `transport`) are
not Modules and cannot own or register Servers.

### HcpMagnet

Each built-in source owns `HcpMagnet.ts`. A Magnet binds one source and produces
exactly one Tool, Capability, or Resource through `toTool()`, `toCapability()`,
or `toResource()`. It does not register itself and does not expose
`toHcpServer()`.

## Assembly

`assembly/sources.generated.ts` is generated from `harness.toml` and registered
component TOML files. `HCP_SERVERS` is the real Server map and `HCP_MAGNETS` is
the only Magnet class list; assembly filters that list by generated metadata
instead of maintaining tool, skill, capability, or resource Magnet lists.
`assembly/session-hcp.ts::HcpClientbuildsession()` constructs the one HcpClient,
registers built-in tools and skills, applies explicitly configured package
sources, and fills default capabilities.

For a selected package overlay, `assembly/session-hcp.ts` converts descriptors
to ordinary HcpClient component settings. Tool settings are built through
`../tools/descriptor/HcpMagnet.ts` and
`../tools/descriptor/package-tool.ts::createPackageToolProduct()`. Slot overlays
preserve unrelated slots in the same module. Concrete domain packages are
independently managed in `MagentaPackages`; a production connector for that
repository is deferred and must not hardcode its location.

`_magenta/` is outside this chain. It contains host/shared Magenta support code
such as session storage, environment adapters, messages, types, and utilities;
it is not a set of Modules or a contract layer and is never generated into
`HCP_SERVERS` or `HCP_MAGNETS`.

## Transport

Transport mechanism is not source identity and does not create Magnet subtypes:

- `../tools/process-tool.ts::ProcessTool` handles one-shot processes.
- `../tools/python-module-tool.ts::PythonModuleTool` handles Python modules.
- `transport/mcp.ts::McpTool` adapts tools from a shared MCP connection.
- `transport/hcp-process.ts::HcpMagnetProcess` is an injectable JSONL boundary
  that an owning source may explicitly construct and use.

`HcpMagnetProcess` is not a Module, source role, or automatically assembled
Magnet. Transport owns no Server and registers no address; dynamic products
remain under a real Module/Server and source Magnet. There is no Universal
Magnet and no `.HCP/magnet/` transport zone. Production default assembly has no
reference to `HcpMagnetProcess`; a source that needs JSONL must inject it
explicitly.

## Runtime

HCP is an assembly and management path, not the agent loop's execution
middleware. Once resolved, tools and live capability instances are called
directly.

## Verification

```bash
npm run generate:hcp-sources -- --check
npm run check:structure
npm run build
npm test
```
