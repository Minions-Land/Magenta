# Harness Development Contract

Date: 2026-07-11
Status: **CURRENT.** Architecture is authoritative in
[`hcp-architecture.md`](./hcp-architecture.md); naming is authoritative in
[`hcp-naming.md`](./hcp-naming.md). This document defines the operating rules
for changing that architecture without creating parallel concepts.

## 1. Runtime Law

Every assembled component follows one chain:

```text
HcpClient -> HcpServer -> HcpMagnet -> Tool | Capability | Resource
```

The implications are strict:

1. Client, Server, and Magnet are the only HCP roles.
2. Every real Module owns `HcpServer.ts`; every declared Source owns
   `HcpMagnet.ts`.
3. Common selection, routing, and lifecycle behavior belongs to `HcpClient`.
   An `HcpServer` keeps only its Module identity and unique operations.
4. A returned Magnet exposes exactly one product. A build may fan out only into
   sibling single-product Magnets with distinct selectors.
5. HCP ends after assembly and resolution. Tools and live capability values are
   called directly at runtime.

Do not add role interfaces, base role classes, anonymous or per-Magnet Servers,
a second Client, a contract layer, or another selection/lookup service.

## 2. Code Ownership

### Generic Protocol

`HarnessComponentProtocol/HcpClient.ts` and `HarnessComponentProtocol/.HCP/`
own generic HCP behavior:

- Server and Magnet protocol data;
- static generated declarations;
- component dependency ordering, construction, routing, cleanup, and session
  Client creation; and
- optional explicitly injected HCP JSONL transport.

Generic assembly accepts ordinary component rows and Source settings. It must
not parse Package manifests, discover MCP servers, inspect CLI configuration,
or branch on Magenta host concepts.

### Magenta Host Support

`HarnessComponentProtocol/_magenta/` owns private host and shared support:

- Package manifest parsing and overlay conversion;
- MCP clients, schemas, caching, connections, and Tool adaptation;
- session storage, environment adapters, messages, shared types, and utilities;
- shared process-tool binaries.

These directories are not Harness Modules or Sources. They own no `HcpServer`,
never appear in generated declarations, and do not form a fourth management
layer. An owning Source may call them, then return a normal Magnet product.

### Application Composition

`pi/coding-agent` owns CLI/TUI composition, settings, authentication, the
resource loader, and active session policy. It consumes the package-level
`@magenta/harness` API and must not choose implementations through deep Source
imports.

## 3. Declarations And Generation

`HarnessComponentProtocol/harness.toml` and its referenced component TOML files
are the repository declaration source of truth. Codegen produces exactly:

- `HCP_SERVERS`: real Module Server classes keyed by Module path;
- `HCP_MAGNETS`: Source Magnet classes plus the static data required to select
  and build them.

These generated values are disposable data. They are not an Inventory,
Registration, Registry, or another HCP role. Consumers may filter the single
`HCP_MAGNETS` list; they must not maintain product-specific lists, builder maps,
default-Source maps, or central Source switches.

Adding a repository component should require its TOML declaration, real role
files, implementation, tests, and regeneration. If an ordinary Source requires
editing several central selection files, the design has drifted.

## 4. Source And Product Rules

Source names identify implementation origin: `pi`, `magenta`, `codex`, or
`claude-code`. Runtime technology is not Source identity. Process, Rust, Python,
script, MCP, API, and JSONL details live inside the Source that owns them.

`descriptor` is the one reserved host-input Source. Repository-declared
`descriptor/HcpMagnet.ts` files adapt validated Tool or Resource settings from
the host or a Package. This does not permit arbitrary mechanism-named Sources.

Products are mutually exclusive:

- **Tool**: an `AgentTool` called by the agent loop;
- **Capability**: a live host value resolved by slot;
- **Resource**: inert content or file metadata merged by the resource loader.

Product adapters such as `ProcessTool`, `PythonModuleTool`, and `McpTool` are
not Magnets or HCP roles. `HcpMagnetProcess` is optional JSONL plumbing injected
by an owning Source; it is not a Module, Source, generated component, or default
process path.

## 5. Package Boundary

Magenta3 keeps a generic Package integration surface but does not own concrete
domain expert packages. Root `packages/` therefore contains only documentation
and a generic template.

The intended flow is:

```text
future GitHub acquisition and cache
-> verified local Package root
-> --harness-packages-root / packagesRoot
-> _magenta Package overlay
-> ordinary HcpClient component inputs
-> normal HcpServer and HcpMagnet ownership
```

The GitHub acquisition, version selection, verification, and cache layer is not
implemented yet. External integration should explicitly supply its downloaded
root. If `packagesRoot` is omitted, the API falls back only to
`<repoRoot>/packages`; it must not require a submodule, vendor domain content,
or infer a sibling checkout such as `MagentaPackages`.

Package precedence and profile expansion stay in `_magenta/packages/`. Generic
`.HCP/assembly/` sees only normal inputs and must not add Package-specific
builders, categories, or routing.

## 6. Change Discipline

Before implementation:

1. Identify the owning Module, Source, product, and code boundary.
2. Check the TOML and generated declarations instead of guessing an interface.
3. Reuse an existing HcpClient, HcpServer, HcpMagnet, or product adapter when it
   already owns the behavior.
4. Reject new architecture nouns unless they name a necessary real entity and
   comply with the naming law.

During review, require evidence that:

- external behavior remains compatible unless a behavior change was requested;
- no host concern leaked into `.HCP/`;
- no generic HCP role leaked into `_magenta/` support code;
- no generated file or parallel lookup table was hand-maintained;
- dynamic products still route through a real Server and Source Magnet; and
- Package integration remains independent of acquisition location.

Historical rollout records in `log.md` and `hcp-rollout-progress.md` preserve
old names and paths intentionally. They are not current implementation guidance.

## 7. Verification Gates

From the repository root:

```bash
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
npm run check:assumptions -w @magenta/harness
npm run build -w @magenta/harness
npm test -w @magenta/harness
```

When a change crosses into app composition, CLI, TUI, or resource loading, also
run the relevant `pi/coding-agent` tests and the repository-wide gates:

```bash
npm run build
npm run check
npm test
```

For real TUI behavior, launch the built application with
`node pi/coding-agent/dist/cli.js` and exercise the affected user workflow.
