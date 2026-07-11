# HCP Overview

HCP assembles selectable harness components through one ownership chain:

```text
HcpClient -> real module HcpServer -> selected source HcpMagnet -> source product
```

The authoritative contract is `../docs/governance/hcp-architecture.md`; naming
is authoritative in `../docs/governance/hcp-naming.md`.

## Responsibilities

### HcpClient

`../HcpClient.ts` is the single session router. Assembly attaches a real Module
Server and its selector-to-Magnet slots through `registerModule()`. The Client
owns address routing, Source selection, descriptions, calls, and instance
resolution.

### HcpServer

Each module owns a real `HcpServer.ts`. Leaf modules such as `tools/read` and
grouping modules such as `tools` or `skills` are explicit entities.
Tools and skills therefore keep both layers: the root grouping Server and every
declared leaf's own Server.

Assembly does not synthesize anonymous, facade, or per-Magnet Servers.
Infrastructure directories (`assembly`, `transport`) are not Modules and
cannot own Servers.

### HcpMagnet

Each repository-declared Source owns `HcpMagnet.ts`. A Magnet binds one Source
and produces exactly one Tool, Capability, or Resource through `toTool()`,
`toCapability()`, or `toResource()`. It does not attach itself and does not
expose `toHcpServer()`. An aggregate input whose sibling selectors are unique
(currently the root `tools/descriptor` Source and Resources) may expand one
build into multiple sibling Magnets, but every returned Magnet still owns
exactly one product. Fixed capability slots and leaf Tool Modules require one
product per component; assembly rejects fan-out there.

## Assembly

`assembly/sources.generated.ts` is generated from `harness.toml` and its
declared component TOML files. `HCP_SERVERS` is the real Server map and
`HCP_MAGNETS` is the only generated Magnet list; assembly filters it by static
metadata instead of maintaining product-specific lists.
`assembly/session-hcp.ts::HcpClientbuildsession()` constructs the one HcpClient,
accepts only ordinary component inputs and Source settings, resolves their
dependencies, calls `HcpMagnet.build()`, routes each returned Magnet, and
releases returned products that cannot be validated or routed. It fills
unoccupied repository defaults without interpreting where host-supplied inputs
came from.
In particular, `.HCP/assembly/` does not parse Package declarations, discover
MCP servers, or manage MCP connections.

For selected Package content, `../_magenta/packages/package-overlay.ts` parses
the generic contract and
`../_magenta/packages/hcp-client-components.ts::HcpClientpackageinputfromoverlay()`
maps the result to the same component inputs accepted by HCP assembly. The host
loads an explicitly supplied root containing already-downloaded Packages and
passes those inputs to `HcpClientbuildsession()`; no HCP code infers a fixed
Package location. `../tools/descriptor/HcpMagnet.ts` owns construction for both
Package tool descriptors and configured user MCP servers. One MCP server build
may return multiple sibling Magnets, one per discovered tool, while each Magnet
still owns one product and the shared connection remains transport plumbing.

Concrete domain Packages will be published in independent GitHub repositories.
A future acquisition layer will download, select versions, verify, and cache
them; none of that acquisition work is implemented here. Magenta3's root
`packages/` retains only the generic contract and templates and has no dependency
on a sibling Package checkout.

`_magenta/` is outside this chain. It contains host/shared Magenta support code
such as Package parsing, MCP transport support, session storage, environment
adapters, messages, types, and utilities; it is not a set of Modules or a
contract layer and is never generated into `HCP_SERVERS` or `HCP_MAGNETS`.

## Transport

Transport mechanism is not source identity and does not create Magnet subtypes:

- `../tools/process-tool.ts::ProcessTool` handles one-shot processes.
- `../tools/python-module-tool.ts::PythonModuleTool` handles Python modules.
- `../_magenta/mcp/tool.ts::McpTool` adapts tools from a shared MCP connection.
- `transport/hcp-process.ts::HcpMagnetProcess` is an injectable JSONL boundary
  that an owning source may explicitly construct and use.

`HcpMagnetProcess` is not a Module, source role, or automatically assembled
Magnet. Transport owns no Server or address; dynamic products
remain under a real Module/Server and source Magnet. There is no Universal
Magnet and no `.HCP/magnet/` transport zone. Production default assembly has no
reference to `HcpMagnetProcess`; a source that needs JSONL must inject it
explicitly.

## Runtime

HCP is an assembly and management path, not the agent loop's execution
middleware. Once resolved, tools and live capability instances are called
directly.

## Verification

From `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure
npm run build
npm test
```
