# Memory

This directory contains two related surfaces with separate build ownership:

- `magenta/` is the Harness `memory` Source. Its `HcpMagnet` builds the
  experimental session-grounding capability, and the parent
  `@magenta/harness` workspace compiles it together with `HcpServer.ts`. This
  capability is not autoloaded and the default coding-agent turn/context path
  does not consume it.
- `pi/` is the source of the independent `@magenta/memory` npm workspace. It
  provides an in-memory semantic store and embedding utilities and compiles to
  `dist/pi/`.

The workspace boundary is intentional: publishing the semantic-memory library
does not pull HCP assembly types into its package output.

## Key Exports

### Types
- `MemoryEntry` — Memory entry with metadata (content, description, type, tags, embedding)
- `MemoryStore` — Structural type for memory storage backends
- `EmbeddingProvider` — Structural type for embedding generation
- `SearchResult` — Search result with similarity score

### Implementations
- `InMemoryStore` — In-memory implementation of MemoryStore
- `ModelsEmbeddingProvider` — Adapts a host-extended pi-ai `Models` collection
- `SimpleHashEmbedding` — Simple hash-based embedding (for testing)

### Utilities
- `cosineSimilarity()` — Calculate cosine similarity between vectors
- `euclideanDistance()` — Calculate Euclidean distance
- `normalize()` — Normalize vector to unit length

## Memory Types

```typescript
type MemoryType = "user" | "feedback" | "project" | "reference";
```

- **user** — Information about the user (role, expertise, preferences)
- **feedback** — User feedback on how the agent should work
- **project** — Project-specific information and constraints
- **reference** — External resources (URLs, docs, tickets)

## Usage

```typescript
import { InMemoryStore, SimpleHashEmbedding } from "@magenta/memory";

// Deterministic local embeddings are useful for tests and offline prototypes.
// Production callers can inject any object matching EmbeddingProvider.
const embeddingProvider = new SimpleHashEmbedding();
const memoryStore = new InMemoryStore(embeddingProvider);

// Create a memory
const memory = await memoryStore.create({
  content: "User prefers TypeScript over JavaScript",
  description: "Language preference for code examples",
  type: "user",
  tags: ["preference", "language"]
});

// Search by semantic similarity
const results = await memoryStore.search({
  query: "What language should I use for examples?",
  limit: 5,
  minScore: 0.7
});

for (const result of results) {
  console.log(`Score: ${result.score}`);
  console.log(`Content: ${result.entry.content}`);
}
```

## Memory Entry Structure

```typescript
type MemoryEntry = {
  id: string;                    // Unique ID
  content: string;               // Memory content (markdown)
  description: string;           // One-line description for retrieval
  type: "user" | "feedback" | "project" | "reference";
  tags?: string[];               // Optional tags for filtering
  createdAt: number;             // Creation timestamp
  updatedAt: number;             // Last update timestamp
  embedding?: number[];          // Embedding vector (if available)
};
```

## Search Options

```typescript
type SearchOptions = {
  query: string;                 // Query string
  limit?: number;                // Maximum results (default: 10)
  type?: MemoryType;             // Filter by type
  tags?: string[];               // Filter by tags
  minScore?: number;             // Minimum similarity (0-1)
};
```

## Embedding Providers

### ModelsEmbeddingProvider

`@earendil-works/pi-ai` does not itself define an embedding operation. A host
that installs one can express the augmented surface as `EmbeddingModels` and
adapt it without weakening the type system:

```typescript
import {
  ModelsEmbeddingProvider,
  type EmbeddingModels
} from "@magenta/memory";

const models = hostModels as EmbeddingModels;
const provider = new ModelsEmbeddingProvider(models, "voyage-3");

const embedding = await provider.embed("Some text to embed");
```

### SimpleHashEmbedding

Hash-based embedding for testing (no API calls):

```typescript
const provider = new SimpleHashEmbedding();
const embedding = await provider.embed("Some text");
```

## Storage Backends

Currently only in-memory implementation is available:

```typescript
const store = new InMemoryStore(embeddingProvider);
```

Future backends:
- **SQLite** — Persistent local storage
- **Vector DB** — Dedicated vector database (Qdrant, Milvus, etc.)
- **Cloud** — Remote storage with sync

## Harness Selection

```toml
[[components]]
kind = "memory"
name = "memory"
path = "memory/memory.toml"
```

The TOML selects the `magenta` Source for the session-grounding capability but
marks it non-autoload. A host must explicitly select the `memory` Module and
connect its output to a context consumer. The generated HCP arrays and runtime
routing remain owned by `HcpClient`; memory has no parallel selection or
assembly state.

## Dependencies

- `@earendil-works/pi-ai` — Base `Models` surface extended by host embedding adapters

## Potential Harness Use Cases

These are integration targets, not features of the default coding-agent path:

1. **Remember command** — Store user preferences and context
2. **Long-term context** — Persist information across sessions
3. **Knowledge retrieval** — Find relevant past conversations
4. **Preference learning** — Learn user's coding style and preferences
5. **Project context** — Remember project-specific details

## Architecture Notes

The memory module provides **semantic retrieval** based on vector embeddings. Unlike session storage (which stores conversation history), memory is designed for:
- Long-term persistence
- Semantic search (not just keyword matching)
- Cross-session recall
- Structured metadata (types, tags)

This complements the session module which handles short-term conversation history.
