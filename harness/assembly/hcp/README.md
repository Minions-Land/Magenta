# HCP Module

The **HCP** (Harness Component Protocol) module provides the management and discovery layer for harness components.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `hcp/pi/hcp.ts`

## Key Exports

- `HcpRegistry` — In-process registry for component discovery and dispatch
- `HcpTarget` — Interface for components exposing management endpoints
- `HcpCall` — Structure for management operations
- `HcpContext` — Ambient context for assembly-time operations
- `HcpRegistry.describeAll()` — Describe registered exact/prefix targets

## Design Principle

**HCP is NOT on the agent loop's hot path.** The loop calls `tool.execute()` directly (in-process, no RPC). HCP exists purely for:
- Component discovery at startup
- Configuration management
- Lifecycle operations during assembly

This separation keeps the loop fast (direct calls) while providing extensibility.

## Usage

```typescript
import { HcpRegistry, HcpTarget } from "@magenta/harness";

const registry = new HcpRegistry();

// Register a target under a prefix
registry.register("tool", toolTarget);

// Register an exact address
registry.registerExact("tool:read", readToolTarget);

// Dispatch a call
const result = await registry.dispatch({
  target: "tool:read",
  op: "describe",
  context: { cwd: "/path/to/project" }
});

const targets = await registry.dispatch({
  target: "hcp:registry",
  op: "list"
});
```

## Target Addressing

Targets use URI-like addresses:
- `"tool:read"` — Exact match takes precedence
- `"tool:*"` — Falls back to prefix `tool`
- `"native:tool/read"` — Another prefix example

The portion before the first `:` is the prefix used for resolution.

## HcpTarget Interface

Components implement `HcpTarget` to expose management operations:

```typescript
interface HcpTarget {
  describe(): HcpTargetDescription;
  call(call: HcpCall): Promise<unknown> | unknown;
}
```

Supported operations are component-specific, but Magnets should expose a common
baseline: `"describe"`, `"configure"`, `"enable"`, `"disable"`, `"state"`,
`"health"`, and optionally `"toTool"`.

## Registry Management Target

`HcpRegistry` reserves `hcp:registry` as a local management target:

- `list` / `discover` — Return all target descriptions
- `prefixes` — Return registered prefixes
- `addresses` — Return exact registered addresses

## Registration

```toml
[[components]]
kind = "assembly"
name = "hcp"
path = "hcp/hcp.toml"
```

## Dependencies

- Types (HcpContext, component metadata)

## Architecture Notes

HCP provides **in-process dispatch** for local targets. Process-based components
can still speak HCP over JSONL through `HcpProcessMagnet`; that transport is a
Magnet implementation detail, not the agent loop hot path.
