# HCP Unified Architecture Contract

Date: 2026-07-11
Status: **AUTHORITATIVE.** This is the source of truth for HCP ownership,
assembly, routing, and transport. Naming details are authoritative in
`hcp-naming.md`.

## 1. The Only Resolution Chain

Every assembled component follows one ownership chain:

```text
HcpClient -> real module HcpServer -> selected source HcpMagnet -> source product
```

There is no anonymous Server, per-Magnet Server, facade Server, prefix Server,
or parallel selection/lookup service. A Magnet never creates a Server.
`HcpClient.resolve()` returns the real `HcpServer` owned by a Module directory;
consumers that need the selected product use `resolveInstance()` or
`resolveCapability()`.

`HcpClient`, `HcpServer`, and `HcpMagnet` are the only runtime HCP entities.
Generated arrays, component inputs, Package declarations, and transport helpers
are data or support plumbing, not additional roles.

HCP performs assembly, selection, and management. It is not the tool execution
hot path: once a tool has been assembled, the agent loop calls
`AgentTool.execute()` directly.

## 2. The Three Roles

### HcpClient

`HarnessComponentProtocol/HcpClient.ts` is the single session router. It owns:

- Module state keyed by the Server's `moduleName`;
- each Module's selector-to-Magnet slots;
- address-to-Module routing pointers; and
- Source-independent `resolve`, `describe`, `call`, and instance resolution.

`registerModule(server, slots)` replaces the module subtree by default.
`registerModule(server, slots, { merge: true })` overlays the supplied slots and
preserves sibling slots already owned by that same Module. Host-supplied
components may request explicit replacement; default assembly subsequently
fills only missing slots.

### HcpServer

Every actual Module or grouping node owns a real, named
`<module>/HcpServer.ts` exporting bare `class HcpServer`. The class declares its
Module identity and, where needed, its Module-specific address, description,
or call behavior. The HcpClient supplies the common routing behavior.

Examples:

- `runtime/HcpServer.ts` owns the multi-slot `runtime` module;
- `tools/read/HcpServer.ts` owns the `tools/read` leaf;
- `tools/HcpServer.ts` and `skills/HcpServer.ts` are real grouping nodes.

These classes are the only Servers in the chain. Source folders do not define
Servers, and assembly does not synthesize anonymous ones. `.HCP/assembly/` and
`.HCP/transport/` are HCP infrastructure, not Harness Modules; neither may own a
Server. Generic Package and MCP support lives under `_magenta/`, outside the HCP
entity tree.

### HcpMagnet

Every repository-declared Source owns a Source-local `HcpMagnet.ts` exporting
bare `class HcpMagnet`. Path supplies identity; the class name is deliberately
the same everywhere.

A Magnet binds one selected Source to its Module and produces exactly one of:

- `toTool()` for an `AgentTool`;
- `toCapability()` for an `HcpMagnetBinding` containing a live instance; or
- `toResource()` for an `HcpMagnetResource`.

A Magnet does not select a Source, own addresses, or implement a
management Server. In particular, `toHcpServer()` is retired.
An aggregate input whose sibling selectors are unique may expand one static
`build()` into multiple sibling Magnet instances, but every returned Magnet
still exposes exactly one of these products. Today that applies to the root
`tools/descriptor` Source and Resources. Fixed capability slots and leaf Tool
Modules require one product per component; Client assembly rejects fan-out
there instead of silently replacing a sibling.

## 3. Entity Tree And Paths

The package root is `HarnessComponentProtocol/`; there is no `modules/` wrapper
and no `hcp-client/`, `hcp-contract/`, or `hcp-magnet/` zone.

```text
HarnessComponentProtocol/
  HcpClient.ts
  .HCP/
    HcpServerTypes.ts
    HcpMagnetTypes.ts
    assembly/
    transport/
  _magenta/
    mcp/
    packages/
    utils/pi/toml.ts
  memory/
    HcpServer.ts
    magenta/HcpMagnet.ts
  runtime/
    HcpServer.ts
    magenta/HcpMagnet.ts
  tools/
    HcpServer.ts
    read/
      HcpServer.ts
      pi/HcpMagnet.ts
```

Most Modules are one level deep. Tools and skills have real root grouping
Servers plus leaf Servers. A nested Source may be deeper when its declared
Source path requires it, for example
`multiagent/workflow/magenta/HcpMagnet.ts`.

`.HCP/` contains only Hcp-prefixed protocol data, Client assembly, and explicit
HCP transport. It is infrastructure, not a Module or a fourth HCP role.
Placement under `.HCP/` does not relax the Hcp-prefix rule for HCP-related names.

`_magenta/` contains private host/shared Magenta support code: Package parsing,
MCP transport support, session storage, environment adapters, message helpers,
shared types, and generic utilities such as TOML parsing. These
directories are not Modules or Sources, define no HCP roles or contract
exceptions, and never appear in generated HCP assembly.

## 4. Assembly And Selection

`harness.toml` and each declared component TOML are the repository source of
truth. `scripts/generate-hcp-sources.mjs` resolves the real Module and Source
paths and generates `.HCP/assembly/sources.generated.ts` with:

- `HCP_SERVERS`, a Module-name-to-Server-class map;
- `HCP_MAGNETS`, the complete and only generated Magnet class list.

Assembly filters `HCP_MAGNETS` by its generated static metadata. Tool,
Capability, and Resource consumers must not create product-specific Magnet
lists.

Do not hand-maintain a second Module/Server map. Adding a repository Module or
Source means adding its real role files and TOML declaration, then regenerating
the assembly file.

`.HCP/assembly/session-hcp.ts::HcpClientbuildsession()` constructs the one
session HcpClient. It accepts only ordinary component inputs and Source settings,
resolves capability dependencies, calls each selected `HcpMagnet.build()`, routes
every returned Magnet through its real Server, and releases returned products
that cannot be validated or routed. Repository defaults fill unoccupied slots
after host-supplied non-tool components and before host-supplied tools.

`.HCP/assembly/` does not import or interpret Package declarations, Package
overlays, MCP server descriptors, MCP schemas, or MCP connections. Hosts may
supply components, but their origin is deliberately opaque to HCP assembly.

Package parsing and selection live in `_magenta/packages/`. The overlay returns
one canonical component list; it does not derive parallel Tool/Resource lookup
systems. `HcpClientpackageinputfromoverlay()` maps supported declarations from
the resolved, already-downloaded local root to the ordinary components and
settings accepted by HCP assembly. External integration should supply
`packagesRoot`; if omitted, discovery falls back only to `<repoRoot>/packages`.
Package paths remain relative to that root, and integration must not infer a
sibling repository, `MagentaPackages`, or submodule path.

The owning Module's repository-declared `tools/descriptor/HcpMagnet.ts`
constructs both Package tool products and configured user MCP products. One MCP
server component may build multiple sibling Magnets, one per discovered tool;
each sibling still contains one product. MCP discovery and connection ownership
remain behind that Source and `_magenta/mcp/`, never in `.HCP/assembly/`.

Magenta3's root `packages/` retains only the generic contract and templates and
does not depend on a fixed Package checkout. Concrete domain Packages will be
maintained and published in independent GitHub repositories. A later acquisition
layer will download, select versions, verify, and cache them; that layer is not implemented
by this change and remains outside HCP.

Selection is consumed once. Consumers never name a Source and never fall back
to a Source-specific import.

## 5. Products And Transport

The shipping Magnet product surface has three mutually exclusive products:
Tool, Capability, and Resource. Prompt-template behavior is represented by the
appropriate Capability or Resource path; it is not a fourth Magnet method.

| Product | Assembly result | Runtime behavior |
|---|---|---|
| Tool | `AgentTool` | loop calls `execute()` directly |
| Capability | `HcpMagnetBinding.instance` | consumer calls the live object directly |
| Resource | inert content/path metadata | resource loader injects or merges content |

Runtime mechanism is not Source identity. Process, Python, script, MCP, and
JSONL support live behind the owning Source and the `.HCP/transport/` plumbing:

- `tools/process-tool.ts::ProcessTool` adapts one-shot process tools;
- `tools/python-module-tool.ts::PythonModuleTool` adapts Python modules;
- `_magenta/mcp/tool.ts` exposes `McpTool` instances from one shared MCP
  connection; and
- `.HCP/transport/hcp-process.ts::HcpMagnetProcess` implements the JSONL HCP
  boundary for an owning Source that explicitly injects and uses it.

`tools/descriptor/HcpMagnet.ts` is the Source construction boundary for Package
tools and configured user MCP servers. Its MCP build may fan one server into
multiple sibling Magnets while preserving a shared connection; generic Client
assembly sees only the returned Magnets and their products.

`HcpMagnetProcess` is not a Harness Module, not a source role file, and not part
of default generated assembly. Transport never owns a Server or address.
Dynamic products must remain under a real owning Module/Server and
Source Magnet. There is no Universal Magnet or transport-owned Server.
Default production assembly does not instantiate or reference
`HcpMagnetProcess`; an owning Source must explicitly inject the helper before it
can be used.

## 6. Addressing

Addresses identify products, while Module names identify Server ownership.
Typical addresses include:

- `tool:read` for a repository-declared tool;
- `tool:<name>` for a Package or other dynamically supplied tool;
- `capability:compaction` for a single-slot capability; and
- `capability:runtime:process` for a named slot in a multi-slot module.

The HcpClient routing index maps each address to `{ module, selector }`. The
selector remains internal to routing; consumers do not compute it.

## 7. TypeScript Boundary

HCP role files use bare classes and structural `type` aliases. They do not use
role interfaces, `implements`, base role classes, or a `contract/` layer.
`HcpServerTypes.ts` and `HcpMagnetTypes.ts` contain protocol data types only;
they do not define substitute Server or Magnet roles.

The management envelope is currently in-process. `HcpServerRequest`,
`HcpServerResponse`, and `HcpServerDescription` name that protocol surface;
cross-process mechanisms adapt at the transport boundary rather than changing
the ownership chain.

## 8. Invariants

1. Exactly one session `HcpClient` owns resolution and selection.
2. Every assembled Module has a real `HcpServer`; every selected declared Source
   has a source-owned `HcpMagnet`.
3. No Magnet exposes `toHcpServer()` and no assembly code creates anonymous
   Servers.
4. Every Magnet produces exactly one Tool, Capability, or Resource; a Source
   build may return multiple single-product sibling Magnets.
5. Consumers are source-agnostic and use package-level APIs.
6. HCP stays off the execution hot path.
7. TOML plus generated static imports remain the repository assembly source of
   truth.
8. The Package adapter maps selected declarations to ordinary component inputs;
   `.HCP/assembly/` has no Package- or MCP-specific branch, and integration does
   not locate domain Package repositories by fixed path.
9. Infrastructure and transports own no Server; `HcpMagnetProcess` is injected
   by an owning Source and is never auto-assembled as a Module.
10. `_magenta/` is generic host/shared support, including Package and MCP
    domains; it is not a set of Modules or a contract layer.
11. `HCP_MAGNETS` is the only generated Magnet list; consumers filter it rather
    than maintaining derived product lists.
12. Root `packages/` contains only the generic contract and templates. GitHub
    acquisition, versioning, caching, and verification remain future host work.

Verification from `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure
npm run build
npm test
```
