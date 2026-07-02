# Messages Module

The **messages** module defines agent message types and utilities.

**Type**: Contract layer (no implementations)

## Structure

This module stays **flat** (no `pi/` subdirectory) because it defines shared contracts used across all harness modules and sources.

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

## Registration

This is registered in `harness.toml` as a read-only `contract` module. It is
always available as part of the harness core API and is not runtime-switchable.

## Related

- See `types/` for core type definitions (`AgentMessage` is defined in `@earendil-works/pi-agent-core`)
