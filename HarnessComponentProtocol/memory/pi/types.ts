/**
 * Core types for the memory system
 */

/** A single memory entry with metadata */
export type MemoryEntry = {
	/** Unique ID for this memory */
	id: string;
	/** Memory content (markdown) */
	content: string;
	/** One-line description for retrieval */
	description: string;
	/** Memory type */
	type: "user" | "feedback" | "project" | "reference";
	/** Optional tags for filtering */
	tags?: string[];
	/** Creation timestamp */
	createdAt: number;
	/** Last update timestamp */
	updatedAt: number;
	/** Embedding vector (if available) */
	embedding?: number[];
};

/** Options for creating a memory */
export type CreateMemoryOptions = {
	content: string;
	description: string;
	type: MemoryEntry["type"];
	tags?: string[];
};

/** Options for updating a memory */
export type UpdateMemoryOptions = {
	content?: string;
	description?: string;
	type?: MemoryEntry["type"];
	tags?: string[];
};

/** Search options */
export type SearchOptions = {
	/** Query string */
	query: string;
	/** Maximum number of results */
	limit?: number;
	/** Filter by type */
	type?: MemoryEntry["type"];
	/** Filter by tags */
	tags?: string[];
	/** Minimum similarity score (0-1) */
	minScore?: number;
};

/** Search result with score */
export type SearchResult = {
	entry: MemoryEntry;
	/** Similarity score (0-1, higher is better) */
	score: number;
};

/** Structural surface for memory storage backends. */
export type MemoryStore = {
	/** Create a new memory */
	create(options: CreateMemoryOptions): Promise<MemoryEntry>;

	/** Get memory by ID */
	get(id: string): Promise<MemoryEntry | null>;

	/** Update existing memory */
	update(id: string, options: UpdateMemoryOptions): Promise<MemoryEntry>;

	/** Delete memory */
	delete(id: string): Promise<void>;

	/** List all memories */
	list(filters?: { type?: MemoryEntry["type"]; tags?: string[] }): Promise<MemoryEntry[]>;

	/** Search memories by semantic similarity */
	search(options: SearchOptions): Promise<SearchResult[]>;
};

/** Structural surface for embedding generation. */
export type EmbeddingProvider = {
	/** Generate embedding for text */
	embed(text: string): Promise<number[]>;

	/** Batch embed multiple texts */
	embedBatch(texts: string[]): Promise<number[][]>;
};
