# Message Support

This private Magenta support library defines agent message types and utilities.
It is not a Harness Module and is not registered with HCP.

## Structure

This library stays flat because it defines shared data and conversion helpers
used across modules and sources.

## Key Exports

- `createCustomMessage()` — Create custom agent messages
- `createCompactionSummaryMessage()` — Compaction summary markers
- `createBranchSummaryMessage()` — Branch summary messages
- `convertToLlm()` — Convert agent messages to LLM format
- Message content utilities and formatters

## Usage

```typescript
import { createCustomMessage, convertToLlm } from "@magenta/harness";

const msg = createCustomMessage("text content");
const llmMessages = convertToLlm(agentMessages);
```

## Related

- See `types/` for core type definitions (`AgentMessage` is defined in `@earendil-works/pi-agent-core`)
