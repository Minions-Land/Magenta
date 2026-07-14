# HCP Change Contract

Status: **AUTHORITATIVE.** The [architecture](./hcp-architecture.md) owns runtime structure and the [naming law](./hcp-naming.md) owns identifiers. This document defines the discipline for changing HCP without creating parallel concepts.

## Runtime Law

Every assembled component follows:

```text
HcpClient -> real Module HcpServer -> selected Source HcpMagnet -> Tool | Capability | Resource
```

The implications are strict:

1. Client, Server, and Magnet are the only HCP roles.
2. Each session has one Client; every real Module owns `HcpServer.ts`; every declared Source owns `HcpMagnet.ts`.
3. Common selection, routing, replacement, and lifecycle behavior belongs to the Client. A Server keeps only Module identity and unique operations.
4. A returned Magnet exposes exactly one product. Explicit fan-out returns sibling single-product Magnets with distinct selectors.
5. HCP ends after assembly and resolution. Runtime consumers call products directly.

Do not add role interfaces, base role classes, anonymous or per-Magnet Servers, a second Client, a contract implementation layer, another registry, or a parallel selection service.

## Ownership

### Generic HCP

`HarnessComponentProtocol/HcpClient.ts` and `.HCP/` own generic protocol behavior:

- Client routing and selection;
- Server and Magnet protocol data;
- generated repository projections;
- component dependency ordering, construction, validation, routing, and cleanup;
- session Client assembly; and
- optional explicitly injected HCP transport.

Generic assembly accepts ordinary component rows and Source settings. It must not parse Package manifests, acquire GitHub releases, discover user MCP configuration, read CLI policy, or branch on Magenta host concepts.

### Magenta Host Support

`HarnessComponentProtocol/_magenta/` owns private host and shared support:

- Package parsing, dynamic role loading, compatibility conversion, and tool adaptation;
- MCP clients, schemas, caches, connections, and Tool products;
- session, environment, message, type, utility, and process-tool support.

These directories are not Modules or Sources. They own no `HcpServer`, never enter generated repository declarations, and do not form a fourth management layer. They convert host inputs into normal HCP inputs or support an owning Source.

### Application Composition

`pi/coding-agent` owns CLI and TUI composition, settings, authentication, resource loading, session policy, and UI renderers. It consumes the public `@magenta/harness` API and must not select an implementation through a deep Source import.

## Declarations And Generation

`harness.toml` and referenced component TOML files are authoritative for repository components. Code generation produces one static projection:

- `HCP_SERVERS`: repository Module Server classes keyed by Module path;
- `HCP_MAGNETS`: repository Source Magnet classes and their selection/build metadata.

Generated values are disposable data, not an Inventory, Registration, Registry, or HCP role. Consumers may filter `HCP_MAGNETS`; they must not maintain product-specific Source lists, builder maps, default-Source maps, or central Source switches.

Adding a repository component requires its TOML declaration, real role files, implementation, tests, and regeneration. If an ordinary Source requires edits to several central selection tables, the design has drifted.

Dynamic schema-v2 Package roles are validated runtime inputs and do not belong in the repository projection. Schema-v1 compatibility conversion is explicitly allowed only inside `_magenta/packages/` and cannot become a second architectural model.

## Source And Product Rules

Source names identify implementation origin, such as `pi` or `magenta`. Runtime technology is not Source identity. Process, native binary, Python, script, MCP, API, and JSONL details live behind the Source that owns them.

Products are mutually exclusive:

- **Tool**: an `AgentTool` called by the agent loop;
- **Capability**: a live binding resolved by slot;
- **Resource**: inert content or file metadata consumed by the resource loader.

`ProcessTool`, `PythonModuleTool`, and `McpTool` are product adapters, not Magnets or roles. `HcpMagnetProcess` is optional JSONL plumbing injected by an owning Source; it is not a Module, Source, generated component, or default process path.

The `descriptor` Source adapts validated host input. It does not authorize arbitrary mechanism-named Sources, and host construction must not replace the real Source identity of a schema-v2 Package Magnet.

## RenderKind Contract

A Tool producer may set `renderKind` to describe the shape of its result data. This is a presentation hint, not an HCP role or routing address.

- Harness Tool definitions and process manifests declare the data-shape name.
- Pi owns renderer implementations and registers them by `renderKind`, never by Tool name or Source.
- One renderer may serve many tools with the same result shape.
- Inline extension renderers may override registry behavior for their own definition.
- Unknown or absent kinds fall back to the normal text renderer; they must not break tool execution.
- TUI and HTML export resolve the same kind so saved output matches interactive output.

A new kind therefore requires producer metadata, a Pi renderer when specialized presentation is needed, fallback coverage, and tests that prove the Tool remains usable without that renderer. Do not add a host-side Tool-name switch.

## Package Boundary

Magenta keeps the generic Package integration surface and template but does not vendor concrete domain Packages. Root `packages/` contains only that contract material.

The implemented flow is:

```text
local root or versioned GitHub selector
-> acquired and SHA-256-verified local Package root
-> manifest and path validation
-> schema-v2 dynamic HcpServer/HcpMagnet loading
-> ordinary HcpClientcomponent inputs
-> normal session assembly
```

Schema-v2 is required for new Packages. Every contributed Module and Source carries its real role class. Tool Magnets may call the Client-injected host builder to reuse sandbox, runtime, process, script, or MCP products while retaining Package Source ownership.

Schema-v1 flat overlays remain compatibility input. Their conversion is host-owned and cannot leak Package-specific branching into `.HCP/assembly/`.

Package precedence, profile expansion, acquisition, verification, safe extraction, caching, and manifest parsing remain outside `.HCP/`. Integration must not depend on a submodule, vendored domain content, or inferred sibling checkout.

## Session Planning State

The HCP Todo tool is the session's single plan and progress source. Its complete versioned state lives in tool-result details so session branching restores the matching plan.

- The top-level tool `action` is only `get` or `apply`.
- Every mutation is an atomic non-empty `operations` array under `action: "apply"`.
- Mutation names such as `add`, `update`, and `set_status` belong only in `operations[].op`.
- A one-operation change is still one `apply` batch.
- `reset` may archive only a non-empty plan whose every node is `completed`; it clears the active plan while preserving globally allocated node IDs.
- Completed-plan history is part of the complete Todo snapshot, so each selected session branch restores its own active plan and history.
- Valid version-1 Todo snapshots migrate to the current state version without losing their active plan.
- Research orchestration must keep plan, current item, completion criteria, progress, summary, and evaluation outcomes in Todo.
- It must not mirror that state into `plan.md`, `progress.md`, `contract.md`, `reflection.md`, or an assistant-maintained parallel checklist.

Files are still valid when they are requested deliverables, experiment data, or necessary evidence rather than a second state ledger.

## Change Discipline

Before implementation:

1. Identify the owning Module, Source, product, and code boundary.
2. Read the TOML, generated projection, public API, and nearest tests instead of guessing a contract.
3. Reuse the existing Client, Server, Magnet, host adapter, or product adapter that owns the behavior.
4. Reject new architecture nouns unless they name a necessary entity and comply with the naming law.

During review, require evidence that:

- external behavior remains compatible unless a behavior change was requested;
- no host concern leaked into `.HCP/`;
- no generic role leaked into `_magenta/` support code;
- no generated file or parallel lookup table was hand-maintained;
- dynamic products still route through a real Server and Source Magnet;
- Package integration remains independent of acquisition location;
- live rejected or replaced products are disposed; and
- tests cover failure and lifecycle transitions, not only the happy-path shape.

## Verification Gates

From the repository root:

```bash
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
npm run check:assumptions -w @magenta/harness
npm run build -w @magenta/harness
npm test -w @magenta/harness
```

When a change crosses app composition, CLI, TUI, or resource loading, run the focused dependent tests and the repository-wide gates:

```bash
npm run check:docs
npm run build
npm run check
npm test
```
