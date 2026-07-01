# Magnet Module

The **magnet** module provides connectors that adapt implementations into harness-consumable shapes.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `magnet/pi/`

## Key Concept

A **Magnet** is a connector that adapts one kind of implementation (native TypeScript today; MCP/API/process later) into the shapes the harness assembly layer consumes:

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

Future magnets will support:
- **McpMagnet** — MCP-based tools
- **RemoteMagnet** — HTTP/RPC tools
- **ProcessMagnet** — Subprocess-based tools

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
