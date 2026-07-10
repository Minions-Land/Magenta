// Core types

export type { EmbeddingModels } from "./embedding-provider.ts";
export { ModelsEmbeddingProvider, SimpleHashEmbedding } from "./embedding-provider.ts";

// Implementations
export { InMemoryStore } from "./in-memory-store.ts";
export type {
	CreateMemoryOptions,
	EmbeddingProvider,
	MemoryEntry,
	MemoryStore,
	SearchOptions,
	SearchResult,
	UpdateMemoryOptions,
} from "./types.ts";

// Utilities
export { cosineSimilarity, euclideanDistance, normalize } from "./vector-utils.ts";
