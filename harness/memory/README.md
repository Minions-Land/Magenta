# Memory Module

The **memory** module provides embedding-based semantic memory storage and retrieval.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `memory/src/`

## Key Exports

### Types
- `MemoryEntry` — Memory entry with metadata (content, description, type, tags, embedding)
- `MemoryStore` — Interface for memory storage backends
- `EmbeddingProvider` — Interface for embedding generation
- `SearchResult` — Search result with similarity score

### Implementations
- `InMemoryStore` — In-memory implementation of MemoryStore
- `ClaudeEmbeddingProvider` — Uses Claude API for embeddings
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
import { InMemoryStore, ClaudeEmbeddingProvider } from "@magenta/memory";

// Create memory store with embedding provider
const embeddingProvider = new ClaudeEmbeddingProvider(apiKey);
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
interface MemoryEntry {
  id: string;                    // Unique ID
  content: string;               // Memory content (markdown)
  description: string;           // One-line description for retrieval
  type: "user" | "feedback" | "project" | "reference";
  tags?: string[];               // Optional tags for filtering
  createdAt: number;             // Creation timestamp
  updatedAt: number;             // Last update timestamp
  embedding?: number[];          // Embedding vector (if available)
}
```

## Search Options

```typescript
interface SearchOptions {
  query: string;                 // Query string
  limit?: number;                // Maximum results (default: 10)
  type?: MemoryType;             // Filter by type
  tags?: string[];               // Filter by tags
  minScore?: number;             // Minimum similarity (0-1)
}
```

## Embedding Providers

### ClaudeEmbeddingProvider

Uses Claude API to generate embeddings:

```typescript
const provider = new ClaudeEmbeddingProvider(apiKey, {
  model: "claude-3-opus-20240229",
  baseUrl: "https://api.anthropic.com"
});

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

## Registration

```toml
[[components]]
kind = "memory"
name = "memory"
path = "memory/memory.toml"
```

## Dependencies

- `@earendil-works/pi-ai` — For Claude API integration

## Use Cases

1. **/remember command** — Store user preferences and context
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
