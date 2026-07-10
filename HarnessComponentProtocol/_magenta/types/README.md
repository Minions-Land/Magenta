# Shared Types

This private Magenta support library defines shared data types used across the
harness. It is not a Harness Module or an HCP contract layer.

## Structure

This library stays flat because its data types are source-independent.

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

## Note

`AgentMessage` and `AgentTool` types come from `@earendil-works/pi-agent-core`, not from this module. This module re-exports and extends them for harness-specific use cases.
