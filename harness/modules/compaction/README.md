# Compaction Module

The **compaction** module provides context compaction and branch summarization for agent loop memory management.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `compaction/pi/`

## Key Exports

- `compact()` — Compact a conversation branch to fit within token budgets
- `prepareCompaction()` — Analyze messages and prepare compaction strategy
- `generateBranchSummary()` — Generate AI summary of a conversation branch
- `collectEntriesForBranchSummary()` — Collect messages for summarization
- `DEFAULT_COMPACTION_SETTINGS` — Default compaction configuration

## Usage

```typescript
import { compact, prepareCompaction, DEFAULT_COMPACTION_SETTINGS } from "@magenta/harness";

const prep = prepareCompaction(messages, settings);
const result = await compact(prep, model, session);
```

## How It Works

1. **Analysis**: Scan messages to identify what can be compacted (old assistant outputs, long tool results)
2. **Strategy**: Decide what to summarize, truncate, or remove based on token budget
3. **Execution**: Generate AI summaries for branches, insert compaction markers
4. **Result**: Compacted message list that fits within limits while preserving context

## Registration

```toml
[[components]]
kind = "compaction"
name = "compaction"
path = "compaction/compaction.toml"
```

## Dependencies

- Session (for branch traversal)
- Messages (message utilities)
- AI model (for summary generation)
