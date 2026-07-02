# Types Module

The **types** module defines shared types and contracts used across harness.

**Type**: Contract layer (no implementations)

## Structure

This module stays **flat** (no `pi/` subdirectory) because it defines type contracts shared across all sources.

## Key Exports

### Core Types
- `Session`, `SessionTreeEntry` — Session and tree structures
- `Result<T>`, `ok()`, `err()` — Result type for error handling
- `ExecutionEnv` — Environment context for tool execution

### Error Types
- `SessionError`, `CompactionError`, `BranchSummaryError` — Domain-specific errors
- `toError()` — Error conversion utility

### Component Types
- `Skill`, `PromptTemplate` — Skill and template interfaces
- `AgentHarness` — Re-exported from loop (for type references)

### Enums
- `QueueMode`, `ThinkingLevel` — Agent configuration enums

## Usage

```typescript
import type { Session, Result, ExecutionEnv } from "@magenta/harness";
import { ok, err, SessionError } from "@magenta/harness";

function doSomething(): Result<string> {
  if (success) return ok("value");
  return err(new SessionError("failed"));
}
```

## Registration

This is registered in `harness.toml` as a read-only `contract` module. It is
always available as part of the harness core API and is not runtime-switchable.

## Note

`AgentMessage` and `AgentTool` types come from `@earendil-works/pi-agent-core`, not from this module. This module re-exports and extends them for harness-specific use cases.
