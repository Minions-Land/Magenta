# Loop Module

The **loop** module provides the main agent harness orchestration.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `loop/pi/agent-harness.ts`

## Key Export

- `AgentHarness` — Main agent loop class that orchestrates:
  - Tool execution
  - Skill invocation
  - Prompt template expansion
  - Context compaction
  - Branch summarization
  - Session management

## Usage

```typescript
import { AgentHarness } from "@magenta/harness";

const harness = new AgentHarness({
  tools: [...],
  skills: [...],
  promptTemplates: [...],
  session: sessionRepo,
  // ...
});

await harness.run(initialMessage);
```

## Registration

Registered in `harness/harness.toml`:
```toml
[[components]]
kind = "loop"
name = "loop"
path = "loop/loop.toml"
```

## Dependencies

- Compaction (branch summarization, context compaction)
- Skills, prompt templates, system prompt
- Session management
- Message utilities
