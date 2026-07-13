# HCP Naming Convention

Status: **AUTHORITATIVE.** This is the single source of truth for HCP naming.

## 0. Iron Law: Naming Hierarchy Equals Entity Tree

Every capital-letter boundary starts an abstraction level, and every level must
correspond to a real entity in code.

- Level 1 is always `Hcp`.
- Level 2 is exactly one of `Client`, `Server`, or `Magnet`.
- Every level after that requires the complete parent entity to exist.
- Everything HCP-related or helping HCP carries the `Hcp` prefix. Directory
  placement does not create an exception. There is no unprefixed escape hatch.

The no-gap rule is literal. `HcpServerRequest` is legal because both
`HcpServer` and `HcpServerRequest` are real entities. If there is no
`HcpClientCapability`, then the capability address constant is
`HcpClientcapabilityprefix`, not `HcpClientCapabilityPrefix`.

Derived rules:

- There are only three HCP roles: Client, Server, and Magnet.
- Name is role; path is identity. Module role files export `class HcpServer` and
  Source role files export `class HcpMagnet`.
- There is no `contract/` role layer, role interface, or role base class.
- Common routing belongs in `HcpClient`; each module Server contains only its
  module-specific identity and behavior.

## 1. Role Ownership

### HcpClient

The Client class lives at `HarnessComponentProtocol/HcpClient.ts` and exports
`class HcpClient`; each session constructs exactly one instance. There is no
per-module Client, prefix Client, alternate Package Client, or fourth role.

### HcpServer

Every actual Module or grouping entity owns `<module>/HcpServer.ts`, exporting
bare `class HcpServer`. Examples:

- `runtime/HcpServer.ts`
- `tools/HcpServer.ts`
- `tools/read/HcpServer.ts`
- `skills/HcpServer.ts`
- `skills/paper-analysis/HcpServer.ts`

Tools and skills require both ownership levels: the root grouping Server does
not replace a leaf Server, and a leaf Server does not replace the root.

There is no `ModuleHcpServer`, `CapabilityHcpServer`, anonymous Server, or
Server produced by a Magnet. Assembly, config parsing, Package overlay, and
transport are infrastructure, not Harness Modules, and therefore cannot own
`HcpServer` role files.

### HcpMagnet

Every declared Source owns a Source-local `HcpMagnet.ts`, exporting bare
`class HcpMagnet`. This includes dynamically loaded schema-v2 Package Sources;
repository declarations additionally enter the generated static projection.
Examples:

- `memory/magenta/HcpMagnet.ts`
- `tools/read/pi/HcpMagnet.ts`
- `multiagent/workflow/magenta/HcpMagnet.ts`

Runtime technology does not form a Magnet subtype hierarchy. Names such as
`UniversalMagnet`, `ProcessToolMagnet`, `PythonModuleToolMagnet`, and
`HcpProcessMagnet` are retired. `ProcessTool`, `PythonModuleTool`, and `McpTool`
are real product/transport entities outside `.HCP/`, not Sources or Magnet role
classes.
`HcpMagnetProcess` is a concrete JSONL transport entity that an owning Source
may inject and use; it is not itself a Module, Source role, or automatically
assembled Magnet. Production default assembly has no reference to it.

## 2. Protocol Data Names

Protocol data hangs under the role that owns or communicates it.

Server communication data:

- `HcpServerRequest`
- `HcpServerResponse`
- `HcpServerContext`
- `HcpServerDescription`

Magnet products and build data:

- `HcpMagnetBinding`
- `HcpMagnetResource`
- `HcpMagnetResourceMergeMode`
- `HcpMagnetBuildContext`

Magnet-side process transport entities:

- `HcpMagnetProcess`
- `HcpMagnetProcessOptions`
- `HcpMagnetProcessManifest`
- `HcpMagnetJsonlRequest`
- `HcpMagnetJsonlResponse`

Client-owned constants with no intermediate entity keep the tail lowercase:

- `HcpClientcapabilityprefix`

Retired names include `HcpRequest`, `HcpResponse`, `HcpContext`, `HcpResource`,
`CapabilitySourceMagnet`, and `CapabilityFactoryContext`.

## 3. Settled Paths

The package is flat under `HarnessComponentProtocol/`. The following legacy
zones and wrappers do not exist:

- `modules/`
- `hcp-client/`
- `hcp-contract/`
- `hcp-magnet/`
- `.HCP/magnet/`

The settled structure is:

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
  <module>/
    HcpServer.ts
    <source>/HcpMagnet.ts
  tools/
    HcpServer.ts
    <tool>/
      HcpServer.ts
      <source>/HcpMagnet.ts
```

`.HCP/HcpServerTypes.ts` and `.HCP/HcpMagnetTypes.ts` contain data types, not
substitute role abstractions. `.HCP/transport/` contains concrete transport
plumbing. It cannot own a Server, attach itself as a Module, or create a
fourth HCP role. `HcpMagnetProcess` lives there as injectable plumbing; it is
not included in generated assembly.

`_magenta/mcp`, `_magenta/packages`, `_magenta/session`, `_magenta/env`,
`_magenta/messages`, `_magenta/types`, and `_magenta/utils` are private
host/shared support libraries. They are not Modules, Sources, HCP roles, or a
contract layer, and they never gain HCP entity names merely from being consumed
by Modules.

## 4. TypeScript Mechanics

- Role files export bare classes: `export class HcpServer` or
  `export class HcpMagnet`.
- Production HCP and module code uses structural `type` aliases, not
  `interface`, `implements`, or a `contract/` layer.
- A Source role class `HcpMagnet` produces exactly one of `toTool()`,
  `toCapability()`, or `toResource()`. Magnet-side data/transport entities such
  as `HcpMagnetProcess` are not source role classes.
- `toHcpServer()` is forbidden. Management behavior belongs to the real Module
  Server.
- Structural correctness is checked where role objects are attached and
  consumed; no separate role interface is imported by every implementation.

## 5. Generated Assembly

Same-name repository role classes are collected by static code generation:

1. `harness.toml` and declared component TOML files identify Module and Source
   paths.
2. `scripts/generate-hcp-sources.mjs` verifies each real role file and generates
   `.HCP/assembly/sources.generated.ts`.
3. `HCP_SERVERS` maps Module names to real `HcpServer` classes.
4. `HCP_MAGNETS` is the only Source `HcpMagnet` class list; consumers filter it
   by generated static metadata rather than maintaining product-specific Magnet
   lists.
5. Assembly attaches those real entities to the session's `HcpClient`.

Schema-v2 Package roles follow the same naming and path law but are dynamically
loaded from validated Package roots. They are runtime inputs, not entries in the
repository-generated projection. Schema-v1 overlays are compatibility data and
must not be used as the model for new role names.

Adding a repository Module/Source requires its TOML declaration and real role
files, followed by this command from `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources
```

Do not add a hand-written parallel Server map or Source list.

## 6. Review Checklist

1. Does the name relate to or help HCP? It starts with `Hcp`, with no directory
   or infrastructure exception.
2. Is level 2 exactly `Client`, `Server`, or `Magnet`?
3. Does every later capitalized level have a real parent entity?
4. Does the role file use the bare role name and let its path carry identity?
5. Is a runtime mechanism being mistaken for a Source or Magnet subtype?
6. Is any assembly path creating an anonymous/facade Server or a second Client?

Examples:

- `HcpServerRequest`: legal Server protocol entity.
- `HcpMagnetProcess`: legal Magnet-process transport entity, injected by an
  owning Source and never assembled as a Module.
- `HcpMagnetJsonlRequest`: legal JSONL request used by `HcpMagnetProcess`.
- `HcpMagnetResource`: legal Magnet product entity.
- `HcpClientcapabilityprefix`: legal lowercase tail because no intermediate
  Client-Capability entity exists.
- `HcpProcessMagnet`: illegal order and retired subtype model.
- `HcpServerProcess`: illegal because the process is Magnet-side transport, not
  a Server entity.
- `HcpRequest`: illegal because level 2 is not a role.

## 7. Enforcement

`scripts/check-structure.mjs` rejects:

- missing or wrongly exported declared `HcpServer.ts` / `HcpMagnet.ts` roles;
- production `interface` declarations and `implements` clauses;
- `toHcpServer` on a Source Magnet;
- retired HCP identifiers such as `CapabilitySourceMagnet` and
  `ModuleHcpServer`; and
- recreation of `.HCP/magnet/` or generic Package/MCP subsystems under `.HCP/`.

`npm run generate:hcp-sources -- --check` rejects drift between TOML, real role
files, and generated static assembly.

Semantic entity-tree checks still require review: tooling cannot decide whether
a newly capitalized concept represents a legitimate parent entity.

## See Also

- [HCP architecture](./hcp-architecture.md): ownership, routing, assembly, and transport
- [HCP contract](./contract.md): invariants and change discipline
- [HCP development](../DEVELOPING.md): task-oriented contribution guide
