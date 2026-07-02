# Magnet Module

The **magnet** module provides connectors that adapt implementations into harness-consumable shapes.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `magnet/pi/`

## Key Concept

A **Magnet** is a connector that adapts one kind of implementation (native
TypeScript, Rust process tools, HCP JSONL processes, MCP/API later) into the
shapes the harness assembly layer consumes:

1. **AgentTool** — Loop-ready tool for direct execution
2. **HcpTarget** — Management endpoint for discovery/configuration

Magnets run **at assembly time only** — they are how concrete implementations get "attracted" into the loop's tool set.

## Interface

```typescript
interface Magnet {
  /** Discriminator for the implementation kind (e.g., "native", "mcp"). */
  kind: string;
  /** Produce a loop-ready tool, if this magnet yields one. */
  toTool?(): AgentTool;
  /** Produce a management endpoint, if this magnet exposes one over HCP. */
  toHcpTarget?(): HcpTarget;
}
```

## Usage Example

```typescript
import { NativeMagnet } from "@magenta/harness";

// Create a magnet wrapping a native TypeScript tool
const magnet = new NativeMagnet({
  name: "read",
  execute: createReadExecute(cwd),
  schema: readSchema,
  // ...
});

// Extract the loop-ready tool
const tool = magnet.toTool();

// Extract the HCP management endpoint
const hcpTarget = magnet.toHcpTarget();
```

## Current Implementations

- **NativeMagnet** (`magnet/pi/native.ts`) — Wraps native TypeScript tools
- **ProcessToolMagnet** (`magnet/pi/process.ts`) — Wraps Magenta1-style
  Rust/process tools. Protocol: spawn `command args...`, write tool arguments as
  JSON to stdin, read stdout as the model-facing tool result.
- **HcpProcessMagnet** (`magnet/pi/hcp-process.ts`) — Wraps external processes
  that speak Magenta HCP over JSONL stdio. This is a management/proxy boundary;
  it does not become an `AgentTool` unless the remote side exposes a tool target.
  Process launch is routed through `runtime://process` so env allowlists, cwd,
  timeout, and portable policy checks match other process-backed Magnets.
- **Package tool factory** (`magnet/pi/package-tool.ts`) — Converts package
  `tool` descriptors into concrete Magnets. This is where package runtime
  descriptors such as `runtime = "process"` or `runtime = "<python-runtime>"`
  choose a language/runtime adapter.
- **UniversalMagnet** (`magnet/pi/universal.ts`) — Base management surface shared
  by non-native magnets.

Future magnets will support:
- **McpMagnet** — MCP-based tools
- **RemoteMagnet** — HTTP/RPC tools

## Common Management Surface

Every Magnet that exposes HCP should support the same baseline operations:

- `describe` — Stable metadata for selectors and assembly.
- `configure` — Merge runtime configuration.
- `enable` / `disable` — Toggle availability without deleting the component.
- `state` — Current enabled/config state.
- `health` — Cheap readiness check.
- `toTool` — Return a loop-ready `AgentTool` when the Magnet yields one.

Rust-based harness components use this same surface. The loop still receives a
plain `AgentTool`; only the implementation behind `execute()` changes.

```typescript
const magnet = new ProcessToolMagnet({
  cwd,
  manifestRoot: "/Users/mjm/Magenta/general-harness",
  manifest: {
    kind: "process",
    name: "AstGrep",
    description: "AST-aware structural search",
    command: "tools/ast-grep/magenta/process-tools/target/release/magenta-process-tools",
    args: ["ast-grep"],
    parameters: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" } } }
  }
});

const tool = magnet.toTool();          // Agent loop hot path
const hcp = magnet.toHcpTarget();      // Assembly/control path
```

Selectors do not need to hand-code adapter selection. Use the catalog factory
once the user picks an entry:

```typescript
const magnet = await createMagnetFromCatalogEntry(catalog, selectedEntry, { cwd });
const tool = magnet.toTool?.();
registerMagnetHcpTargets(hcp, [magnet]);
```

Currently generic catalog assembly supports:

- `kind = "mcp", type = "magnet"` entries backed by Magenta1 process-tool TOML.
- `kind = "hcp-process"` entries backed by JSONL HCP process TOML.

Other catalog entries remain visible to the selector with provenance and
migration state, but need a specific Magnet before they become executable.

Package overlays follow the same rule. The package-overlay module resolves package
profiles and component paths; it does not own language/runtime branching. It
passes `tool` descriptors to `createPackageToolMagnet()`, and new language
adapters should be added there so Python, process, Node/R/Julia, MCP, API, and
WASM integrations all converge through the same Magnet contract.

For the management side, use `registerMagnetHcpTargets(hcp, magnets)` instead of
hand-registering prefixes. The helper registers exact HCP target addresses and
detects duplicate Magnet targets during assembly.

## Registration

```toml
[[components]]
kind = "assembly"
name = "magnet"
path = "magnet/magnet.toml"
```

## Dependencies

- AgentTool interface (from `@earendil-works/pi-agent-core`)
- HCP interfaces (from `hcp/`)

## Architecture Notes

Magnets are the **adapter layer** between raw implementations and the harness. They ensure all tools expose a uniform interface regardless of implementation technology.
