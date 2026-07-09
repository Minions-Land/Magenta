/**
 * A memory entry retained by a memory provider. The provider determines the
 * concrete schema; this is the minimal shape the contract exposes.
 */
export interface MemoryEntry {
	id: string;
	text: string;
	createdAt: number;
}

/**
 * The result of a memory read operation, exposing the provider's full state.
 */
export interface MemoryReadResult {
	name: string;
	target: string;
	description: string;
	content: string;
	entries: MemoryEntry[];
}

/**
 * The result of a memory retain operation, confirming what was stored.
 */
export interface MemoryRetainResult {
	target: string;
	op: "retain";
	id: string;
}

/**
 * The result of a memory recall operation, returning scored matches.
 */
export interface MemoryRecallResult {
	target: string;
	op: "recall";
	query: string;
	matches: Array<MemoryEntry & { score: number }>;
}

/**
 * The result of a memory reflect operation, summarizing matched entries.
 */
export interface MemoryReflectResult {
	target: string;
	op: "reflect";
	query: string;
	matches: Array<MemoryEntry & { score: number }>;
	summary: string;
}

/**
 * The memory capability surface consumed by the agent loop. This is the
 * injection contract: the loop calls the source-selected provider instead of
 * statically importing session-grounding memory, so the assembly layer decides
 * which source (magenta, pi vector-store, ...) supplies the behavior.
 *
 * The contract accommodates both simple fact-store memory (session-grounding)
 * and future vector-store memory providers. Each provider exposes read/retain/
 * recall/reflect operations at minimum; additional operations are provider-specific.
 */
export interface MemoryProvider {
	/**
	 * Read the full memory state, including all retained entries and any
	 * provider-specific content (e.g., base instructions).
	 */
	read(): Promise<MemoryReadResult>;

	/**
	 * Retain a new memory entry. The input must include `text` (or `fact` or
	 * `content`); additional fields (scope, tags, ...) are provider-specific.
	 */
	retain(input: unknown): Promise<MemoryRetainResult>;

	/**
	 * Recall memory entries matching a query. Returns scored matches ordered
	 * by relevance. The input should include `query` and optionally `limit`.
	 */
	recall(input: unknown): Promise<MemoryRecallResult>;

	/**
	 * Reflect on recalled memories, returning both matches and a natural-language
	 * summary. This is a convenience wrapper around recall that formats results
	 * for agent consumption.
	 */
	reflect(input: unknown): Promise<MemoryReflectResult>;

	/**
	 * Optional: get a description of this memory provider for diagnostic/
	 * management purposes. Returns a short label and optional metadata.
	 */
	describe?(): { name: string; description?: string; metadata?: Record<string, unknown> };
}
