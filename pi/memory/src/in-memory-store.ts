import type {
	CreateMemoryOptions,
	EmbeddingProvider,
	MemoryEntry,
	MemoryStore,
	SearchOptions,
	SearchResult,
	UpdateMemoryOptions,
} from "./types.js";
import { cosineSimilarity } from "./vector-utils.js";

/**
 * In-memory implementation of MemoryStore
 * Good for testing and temporary sessions
 */
export class InMemoryStore implements MemoryStore {
	memories = new Map<string, MemoryEntry>();
	idCounter = 0;
	embeddingProvider?: EmbeddingProvider;

	constructor(embeddingProvider?: EmbeddingProvider) {
		this.embeddingProvider = embeddingProvider;
	}

	async create(options: CreateMemoryOptions): Promise<MemoryEntry> {
		const id = `mem_${++this.idCounter}`;
		const now = Date.now();

		const entry: MemoryEntry = {
			id,
			content: options.content,
			description: options.description,
			type: options.type,
			tags: options.tags,
			createdAt: now,
			updatedAt: now,
		};

		// Generate embedding if provider available
		if (this.embeddingProvider) {
			const embedText = `${options.description}\n${options.content}`;
			entry.embedding = await this.embeddingProvider.embed(embedText);
		}

		this.memories.set(id, entry);
		return entry;
	}

	async get(id: string): Promise<MemoryEntry | null> {
		return this.memories.get(id) ?? null;
	}

	async update(id: string, options: UpdateMemoryOptions): Promise<MemoryEntry> {
		const existing = this.memories.get(id);
		if (!existing) {
			throw new Error(`Memory not found: ${id}`);
		}

		const updated: MemoryEntry = {
			...existing,
			content: options.content ?? existing.content,
			description: options.description ?? existing.description,
			type: options.type ?? existing.type,
			tags: options.tags ?? existing.tags,
			updatedAt: Date.now(),
		};

		// Regenerate embedding if content/description changed
		if (this.embeddingProvider && (options.content || options.description)) {
			const embedText = `${updated.description}\n${updated.content}`;
			updated.embedding = await this.embeddingProvider.embed(embedText);
		}

		this.memories.set(id, updated);
		return updated;
	}

	async delete(id: string): Promise<void> {
		this.memories.delete(id);
	}

	async list(filters?: { type?: MemoryEntry["type"]; tags?: string[] }): Promise<MemoryEntry[]> {
		let results = Array.from(this.memories.values());

		if (filters?.type) {
			results = results.filter((m) => m.type === filters.type);
		}

		if (filters?.tags && filters.tags.length > 0) {
			results = results.filter((m) => {
				if (!m.tags) return false;
				return filters.tags!.some((tag) => m.tags!.includes(tag));
			});
		}

		return results.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async search(options: SearchOptions): Promise<SearchResult[]> {
		if (!this.embeddingProvider) {
			// Fallback to simple text matching
			return this.simpleTextSearch(options);
		}

		// Generate query embedding
		const queryEmbedding = await this.embeddingProvider.embed(options.query);

		// Filter memories
		let candidates = Array.from(this.memories.values());

		if (options.type) {
			candidates = candidates.filter((m) => m.type === options.type);
		}

		if (options.tags && options.tags.length > 0) {
			candidates = candidates.filter((m) => {
				if (!m.tags) return false;
				return options.tags!.some((tag) => m.tags!.includes(tag));
			});
		}

		// Only consider memories with embeddings
		candidates = candidates.filter((m) => m.embedding);

		// Calculate similarities
		const results: SearchResult[] = candidates
			.map((entry) => ({
				entry,
				score: cosineSimilarity(queryEmbedding, entry.embedding!),
			}))
			.filter((r) => !options.minScore || r.score >= options.minScore)
			.sort((a, b) => b.score - a.score);

		const limit = options.limit ?? 10;
		return results.slice(0, limit);
	}

	async simpleTextSearch(options: SearchOptions): Promise<SearchResult[]> {
		const query = options.query.toLowerCase();
		let candidates = Array.from(this.memories.values());

		if (options.type) {
			candidates = candidates.filter((m) => m.type === options.type);
		}

		if (options.tags && options.tags.length > 0) {
			candidates = candidates.filter((m) => {
				if (!m.tags) return false;
				return options.tags!.some((tag) => m.tags!.includes(tag));
			});
		}

		// Simple keyword matching score
		const results: SearchResult[] = candidates
			.map((entry) => {
				const text = `${entry.description} ${entry.content}`.toLowerCase();
				const words = query.split(/\s+/);
				const matchCount = words.filter((w) => text.includes(w)).length;
				const score = matchCount / words.length;
				return { entry, score };
			})
			.filter((r) => r.score > 0 && (!options.minScore || r.score >= options.minScore))
			.sort((a, b) => b.score - a.score);

		const limit = options.limit ?? 10;
		return results.slice(0, limit);
	}
}
