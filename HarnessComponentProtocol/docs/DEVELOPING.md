# HCP Development

This guide covers implementation work in `HarnessComponentProtocol/`. Read the authoritative [naming law](./governance/hcp-naming.md), [architecture](./governance/hcp-architecture.md), and [change contract](./governance/contract.md) before adding or moving a component.

## Setup And Gates

From `HarnessComponentProtocol/`:

```bash
npm install
npm run generate:hcp-sources
npm run check:hcp-sources
npm run check:structure
npm run check:assumptions
npm run build
npm test
```

From the repository root, use workspace-qualified commands for focused checks:

```bash
npm run build -w @magenta/harness
npm test -w @magenta/harness
```

`check:structure` validates ownership, role exports, forbidden layers and identifiers, Source declarations, and selected Package assumptions. `check:hcp-sources` fails when generated repository projections differ from TOML and role files. `check:assumptions` guards audited cross-workspace assumptions.

## Choose The Owner

Before writing code, answer four questions:

1. Which Module owns the behavior?
2. Which Source implements it?
3. Is the result a Tool, Capability, or Resource?
4. Is the input a repository declaration or a host-supplied dynamic component?

Use an existing Module when it already owns the concept. Create a new Module only for a distinct management boundary. Runtime technology alone is not a Source or Module.

The required entity tree is:

```text
<module>/HcpServer.ts
<module>/<source>/HcpMagnet.ts
```

Tools and skills also retain their real grouping Servers:

```text
tools/HcpServer.ts
 tools/<tool>/HcpServer.ts
 tools/<tool>/<source>/HcpMagnet.ts
skills/HcpServer.ts
 skills/<skill>/HcpServer.ts
 skills/<skill>/<source>/HcpMagnet.ts
```

Role files export the bare role class. Their path carries identity.

## Add A Repository Tool Source

A native tool normally has:

```text
tools/<name>/
  HcpServer.ts
  <name>.toml
  <source>/
    HcpMagnet.ts
    <implementation>.ts
```

The Server contains only Module identity and unique behavior:

```ts
export class HcpServer {
  readonly moduleName = "tools/example";
  readonly description = "Describe the example tool.";
}
```

The Source Magnet declares static identity, builds from `HcpMagnetBuildContext`, and exposes exactly one product:

```ts
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";

export class HcpMagnet {
  static readonly module = "tools/example";
  static readonly kind = "tool";
  static readonly source = "magenta";

  static build(context: HcpMagnetBuildContext) {
    return new HcpMagnet(createExampleTool(context.cwd ?? context.repoRoot));
  }

  constructor(private readonly tool: AgentTool) {}

  toTool() {
    return this.tool;
  }
}
```

The component TOML selects the Source and describes the product:

```toml
kind = "tool"
product = "tool"
name = "example"
source = "magenta"
sources = ["magenta"]
description = "Describe the example tool."
```

Add the component path to `harness.toml`, then regenerate. Do not edit `.HCP/assembly/sources.generated.ts`.

## Add A Capability Or Resource

Capabilities provide live instances through `toCapability()` and usually declare a slot. Dependencies reference capability slots in `requires`; session assembly orders the graph and reports missing dependencies or cycles.

Resources return `HcpMagnetResource` through `toResource()`. Use a package-relative `contentPath` or inline content and an explicit merge mode. Resource values are inert metadata until the coding-agent resource loader consumes them.

A Source class must implement only the product method matching its declared `product`. Prompt, skill, theme, and brand content remain Resource products; they do not create new Magnet methods.

## Dynamic And Descriptor Tools

Use a native Source for in-process TypeScript behavior. Use the existing descriptor and product adapters for validated host input:

- `ProcessTool` for a command or native executable;
- `PythonModuleTool` for an isolated Python module;
- script-runtime adaptation for supported script descriptors;
- `McpTool` for a discovered remote MCP tool.

Those are products, not Source classes. Keep discovery, connection, runtime, and sandbox details behind the owning Source. A descriptor Source may explicitly fan out into sibling single-product Magnets; ordinary tools and fixed capability slots must not.

`HcpMagnetProcess` is opt-in JSONL transport plumbing. Construct it only inside a Source that owns the external process. Never add it to repository assembly as a Module or default Magnet.

## RenderKind

When a Tool returns structured details that benefit from a specialized display, set `renderKind` on the Tool definition or `render_kind` in a process manifest. The value names the result data shape, not the Tool or Source.

Pi owns presentation. Register the matching renderer in `pi/coding-agent/src/core/tools/register-builtin-renderers.ts` and test TUI plus HTML export resolution. Unknown kinds must retain the default text rendering path. Never add a Tool-name switch in the host renderer.

Examples of reusable shapes include file content, search results, shell output, and Todo plans. Reuse an existing kind when the details contract matches.

## Schema-v2 Package Development

New Packages use `schema_version = "magenta.package.v2"`. A minimal tree is:

```text
<package-root>/
  package.toml
  tools/<tool>/
    HcpServer.ts
    <source>/
      HcpMagnet.ts
      <tool>.toml
  skills/<skill>/
    HcpServer.ts
    <source>/
      HcpMagnet.ts
      SKILL.md
```

`package.toml` declares each component path. The runtime loader resolves `<component.path>/HcpMagnet.ts`, derives the owning Module path, loads that Module's `HcpServer.ts`, and validates both classes against the manifest. Paths, symlinks, descriptors, and resource content must remain inside the actual Package root.

Tool Magnets retain their Package Source. Their static `build()` can call the injected `HcpClientbuildtools` setting with a Package-local descriptor; the returned host-backed product remains wrapped by the same Package Magnet. Resource and capability Magnets build directly.

Package-local infrastructure kinds such as Python runtimes, runtime tests, environment descriptions, and locks support Tool construction but do not own Magnets.

Test a local Package through the coding-agent `--harness-packages-root` and `--harness-package` flags. Test a GitHub selector through the same host path after acquisition. GitHub download, checksum verification, safe extraction, and caching are already implemented host behavior.

Schema-v1 loading exists only for backward compatibility. Do not author new v1 manifests or use its generated compatibility classes as an architectural example.

## Todo And Research Orchestration

The HCP Todo tool is the only plan and progress ledger for an orchestrated session. Its top-level action is `get` or `apply`; mutation names live under `operations[].op`:

```ts
await todoTool.execute("call-id", {
  action: "apply",
  operations: [
    { op: "add", ref: "verify", text: "Run HCP gates", status: "in_progress" },
    { op: "set_current", targetRef: "verify" },
  ],
});
```

Never call it with a top-level action such as `{ action: "add" }`. Never modify the research-orchestration skill to mirror Todo state into plan, contract, progress, reflection, or checklist files. Its regression test intentionally scans the capability and copied assets for this invariant.

## Tests

Tests should cover the contract boundary changed:

- generated metadata and selection for declaration changes;
- exact role ownership and bare exports for new Modules or Sources;
- build failure, missing dependency, collision, replacement, and disposal paths;
- exactly-one-product and fan-out restrictions;
- Package manifest, traversal, symlink, dynamic import, and schema compatibility cases;
- renderer fallback and shared `renderKind` behavior;
- complete session state snapshots and branch restoration for stateful tools.

Use temporary directories for Package fixtures. Do not add concrete domain Packages to root `packages/`.

## Review Checklist

- The owning Module, Source, and product are explicit.
- Names follow the entity tree without invented role prefixes.
- `.HCP/` remains host-neutral and `_magenta/` owns host adaptation only.
- Repository declarations regenerate one static projection.
- Dynamic Package roles remain runtime inputs.
- Consumers use public package APIs and never name a Source.
- Live rejected or replaced products are disposed.
- Focused tests and all applicable gates pass.
