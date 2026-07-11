# Session Support

This private Magenta support library provides the session tree and storage
primitives used by the host. It is not a selectable Harness Module, so it owns
no HCP role and does not appear in `harness.toml` or generated assembly.

## Current Surface

- `pi/session.ts`: `Session` and `buildSessionContext()`
- `pi/jsonl-storage.ts`: `JsonlSessionStorage` and JSONL metadata loading
- `pi/memory-storage.ts`: `InMemorySessionStorage` for tests and ephemeral use
- `pi/repo-utils.ts`: storage-to-session helpers
- `pi/uuid.ts`: UUIDv7 generation

`Session`, `buildSessionContext()`, storage helpers, and common session types are
exported from `@magenta/harness`. Concrete storage implementations remain
host-internal and are used directly by Harness tests.

## Session Structure

Sessions maintain a **tree-structured message history** with:
- Messages (user, assistant, tool results)
- Branches (conversation forks)
- Compaction markers (context summarization points)
- Branch summaries (AI-generated summaries of conversation branches)
- Metadata (model changes, thinking level, active tools)

## Usage

```typescript
import { Session } from "@magenta/harness";

// A host supplies an object matching SessionStorage.
const session = new Session(storage);

// Reconstruct context from the currently selected branch.
const context = await session.buildContext();
console.log(context.messages);       // AgentMessage[]
console.log(context.model);          // { provider, modelId }
console.log(context.thinkingLevel);  // persisted string or undefined

// Append a message
await session.appendMessage(userMessage);
```

## Storage Backends

### JsonlSessionStorage
- Stores one session as a `.jsonl` file with a versioned header
- Appends tree entries incrementally through the injected `FileSystem`
- Validates headers, entry shape, and selected leaf state while loading

### InMemorySessionStorage
- Stores entries in memory with the same `SessionStorage` shape
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

## Dependencies

- Messages module (message creation utilities)
- Types module (session types and storage contract)
- Node.js `fs/promises` (for JSONL storage)

## Boundary

The agent loop works against the `Session` and structural `SessionStorage`
surfaces rather than an HCP address. Session persistence is host foundation
code, not a Tool, Capability, Resource, Source, or fourth HCP role.
