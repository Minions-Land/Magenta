# Session Module

The **session** module provides session management with multiple storage backends.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `session/pi/`

## Key Exports

- `Session` — Session tree interface with branching message history
- `buildSessionContext()` — Build context from session path (messages, model, thinking level)
- `JsonlSessionRepo` — JSONL file-based session storage
- `InMemorySessionRepo` — In-memory session storage (for testing)
- Session entry types (`MessageEntry`, `BranchSummaryEntry`, `CompactionEntry`, etc.)

## Session Structure

Sessions maintain a **tree-structured message history** with:
- Messages (user, assistant, tool results)
- Branches (conversation forks)
- Compaction markers (context summarization points)
- Branch summaries (AI-generated summaries of conversation branches)
- Metadata (model changes, thinking level, active tools)

## Usage

```typescript
import { JsonlSessionRepo, buildSessionContext } from "@magenta/harness";

// Create a JSONL-backed session repository
const repo = new JsonlSessionRepo(sessionsDir);
const session = await repo.getOrCreate(sessionId);

// Build context from current path
const context = buildSessionContext(session.getCurrentPath());
console.log(context.messages);       // AgentMessage[]
console.log(context.model);          // { provider, modelId }
console.log(context.thinkingLevel);  // "off" | "low" | "medium" | "high"

// Append a message
await session.appendMessage(userMessage);
```

## Storage Backends

### JsonlSessionRepo
- Stores each session as a `.jsonl` file (one entry per line)
- Supports concurrent reads
- Atomic appends via file locking
- Efficient for streaming/incremental writes

### InMemorySessionRepo
- Stores sessions in memory (Map-based)
- Used for testing and ephemeral sessions
- No persistence

## Session Context

`buildSessionContext()` reconstructs the current state by:
1. Traversing the session path (from root to current entry)
2. Applying state changes (model switches, thinking level, tool changes)
3. Collecting messages (regular messages, branch summaries, compaction summaries)
4. Handling compaction (skipping compacted entries, inserting summary)

## Entry Types

- `MessageEntry` — User/assistant/tool messages
- `BranchSummaryEntry` — AI summary of a conversation branch
- `CompactionEntry` — Context compaction marker
- `CustomMessageEntry` — Custom message types
- `ModelChangeEntry` — Model switch
- `ThinkingLevelChangeEntry` — Thinking level change
- `ActiveToolsChangeEntry` — Available tools change
- `LabelEntry` — User-defined labels
- `SessionInfoEntry` — Session metadata

## Registration

```toml
[[components]]
kind = "session"
name = "session"
path = "session/session.toml"
```

## Dependencies

- Messages module (message creation utilities)
- Types module (session types, storage interface)
- Node.js `fs/promises` (for JSONL storage)

## Architecture Notes

The session module provides **storage abstraction** — the agent loop works against the `Session` interface without knowing the storage backend. This enables:
- Local file storage (JSONL)
- Database storage (future)
- Cloud storage (future)
- Memory-only (testing)
