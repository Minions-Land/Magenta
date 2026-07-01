// Core types
export type {
	CreateMemoryOptions,
	EmbeddingProvider,
	MemoryEntry,
	MemoryStore,
	SearchOptions,
	SearchResult,
	UpdateMemoryOptions,
} from "./types.js";

// Implementations
export { InMemoryStore } from "./in-memory-store.js";
export { ClaudeEmbeddingProvider, SimpleHashEmbedding } from "./embedding-provider.js";

// Utilities
export { cosineSimilarity, euclideanDistance, normalize } from "./vector-utils.js";
