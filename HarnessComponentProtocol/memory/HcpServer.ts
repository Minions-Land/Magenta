import type { HcpMagnetBinding } from "../.HCP/HcpMagnetTypes.ts";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";

export class HcpServer {
	readonly moduleName = "memory";
	readonly description = "Session memory retention, recall, and reflection.";

	private binding(magnet: { toCapability?(): unknown }): HcpMagnetBinding<MemoryProvider> {
		return magnet.toCapability?.() as HcpMagnetBinding<MemoryProvider>;
	}

	describeSource(
		_selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
	): HcpServerDescription {
		const binding = this.binding(magnet);
		return {
			target: "capability:memory",
			kind: "memory",
			ops: ["discover", "list", "describe", "read", "get", "inject", "retain", "recall", "reflect"],
			description: this.description,
			metadata: {
				name: binding.name,
				source: binding.source,
				implementation: "native-ts",
				hotSwappable: magnet.hotSwappable ?? false,
			},
		};
	}

	sourceAddresses(): string[] {
		return ["capability:memory", "memory://session-grounding"];
	}

	callSource(_selector: string, magnet: { toCapability?(): unknown }, request: HcpServerRequest): unknown {
		const provider = this.binding(magnet).instance;
		switch (request.op || "read") {
			case "discover":
			case "list":
				return provider.discover();
			case "describe":
				return provider.describe();
			case "read":
			case "get":
			case "inject":
				return provider.read();
			case "retain":
				return provider.retain(request.input);
			case "recall":
				return provider.recall(request.input);
			case "reflect":
				return provider.reflect(request.input);
			default:
				throw new Error(`Unknown operation: ${request.op} for memory capability`);
		}
	}
}

/**
 * A memory entry retained by a memory provider. The provider determines the
 * concrete schema; this is the minimal shape the capability exposes.
 */
export type MemoryEntry = {
	id: string;
	text: string;
	createdAt: number;
};

/**
 * The result of a memory read operation, exposing the provider's full state.
 */
export type MemoryReadResult = {
	name: string;
	target: string;
	description: string;
	content: string;
	entries: MemoryEntry[];
};

/**
 * The result of a memory retain operation, confirming what was stored.
 */
export type MemoryRetainResult = {
	target: string;
	op: "retain";
	id: string;
};

/**
 * The result of a memory recall operation, returning scored matches.
 */
export type MemoryRecallResult = {
	target: string;
	op: "recall";
	query: string;
	matches: Array<MemoryEntry & { score: number }>;
};

/**
 * The result of a memory reflect operation, summarizing matched entries.
 */
export type MemoryReflectResult = {
	target: string;
	op: "reflect";
	query: string;
	matches: Array<MemoryEntry & { score: number }>;
	summary: string;
};

/**
 * The memory capability surface consumed by the agent loop. This is the
 * injection surface: the loop calls the source-selected provider instead of
 * statically importing session-grounding memory, so the assembly layer decides
 * which source (magenta, pi vector-store, ...) supplies the behavior.
 *
 * The surface accommodates both simple fact-store memory (session-grounding)
 * and future vector-store memory providers. Each provider exposes read/retain/
 * recall/reflect operations at minimum; additional operations are provider-specific.
 */
export type MemoryProvider = {
	/** Describe the targets and operations exposed by this provider. */
	discover(): Record<string, unknown>;

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
	 * Get a description of this memory provider for diagnostic and management
	 * purposes. Returns a short label and optional metadata.
	 */
	describe(): { name: string; description?: string; metadata?: Record<string, unknown> };
};
