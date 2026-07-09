import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
	MemoryProvider,
	MemoryReadResult,
	MemoryRecallResult,
	MemoryReflectResult,
	MemoryRetainResult,
} from "../contract.ts";

export interface SessionGroundingMemoryEntry {
	id: string;
	text: string;
	scope: string;
	tags: string[];
	createdAt: number;
}

export interface SessionGroundingMemoryOptions {
	workspaceRoot: string;
	content?: string;
	description?: string;
	storePath?: string;
	now?: () => number;
}

export interface SessionGroundingReadResult extends MemoryReadResult {
	name: "session-grounding";
	target: "memory://session-grounding";
	entries: SessionGroundingMemoryEntry[];
}

export interface SessionGroundingRetainResult extends MemoryRetainResult {
	target: "memory://session-grounding";
	op: "retain";
	scope: string;
	tags: string[];
	storePath: string;
}

export interface SessionGroundingRecallResult extends MemoryRecallResult {
	target: "memory://session-grounding";
	op: "recall";
	matches: Array<SessionGroundingMemoryEntry & { score: number }>;
}

export interface SessionGroundingReflectResult extends MemoryReflectResult {
	target: "memory://session-grounding";
	op: "reflect";
	matches: Array<SessionGroundingMemoryEntry & { score: number }>;
}

const DEFAULT_DESCRIPTION = "Domain-free base memory for preserving user-driven constraints during harness assembly.";
const DEFAULT_CONTENT = `# Session Grounding

Treat explicit user constraints as harness state, not incidental chat history.

- Preserve user-stated architecture boundaries when composing packs and extensions.
- Prefer pack components over extension components when both provide the same kind:name.
- Keep Magenta core crates domain-free; domain behavior belongs in packs, extensions, or pack-local runtimes.
- Use the canonical term Tool Call for model-invoked tool execution.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
	return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readStringArray(value: unknown, key: string): string[] {
	return isRecord(value) && Array.isArray(value[key])
		? value[key].filter((item): item is string => typeof item === "string")
		: [];
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_-]+/)
		.filter(Boolean);
}

function scoreEntry(entry: SessionGroundingMemoryEntry, query: string): number {
	const terms = tokenize(query);
	if (terms.length === 0) return 1;
	const haystack = `${entry.text} ${entry.scope} ${entry.tags.join(" ")}`.toLowerCase();
	return terms.filter((term) => haystack.includes(term)).length;
}

export class SessionGroundingMemoryProvider implements MemoryProvider {
	private readonly workspaceRoot: string;
	private readonly content: string;
	private readonly description: string;
	private readonly storePath: string;
	private readonly now: () => number;
	private entries: SessionGroundingMemoryEntry[] = [];

	constructor(options: SessionGroundingMemoryOptions) {
		this.workspaceRoot = resolve(options.workspaceRoot);
		this.content = options.content ?? DEFAULT_CONTENT;
		this.description = options.description ?? DEFAULT_DESCRIPTION;
		this.storePath =
			options.storePath ?? resolve(this.workspaceRoot, ".magenta", "memory", "session-grounding.jsonl");
		this.now = options.now ?? Date.now;
	}

	discover(): Record<string, unknown> {
		return {
			provider: "session-grounding-memory",
			targets: ["memory://session-grounding"],
			operations: ["read", "retain", "recall", "reflect", "describe"],
		};
	}

	describe(): { name: string; description?: string; metadata?: Record<string, unknown> } {
		return {
			name: "session-grounding",
			description: this.description,
			metadata: {
				target: "memory://session-grounding",
				operations: ["read", "retain", "recall", "reflect"],
				storePath: this.storePath,
				workspaceRoot: this.workspaceRoot,
				provenance: {
					origin: "magenta",
					source: "general-harness/components/providers/memories/session-grounding/MEMORY.md",
				},
			},
		};
	}

	async read(): Promise<SessionGroundingReadResult> {
		await this.loadStore();
		return {
			name: "session-grounding",
			target: "memory://session-grounding",
			description: this.description,
			content: this.content,
			entries: [...this.entries],
		};
	}

	async retain(input: unknown): Promise<SessionGroundingRetainResult> {
		const text = (
			readString(input, "text") ??
			readString(input, "fact") ??
			readString(input, "content") ??
			""
		).trim();
		if (!text) throw new Error("memory://session-grounding retain requires text");
		await this.loadStore();
		const entry: SessionGroundingMemoryEntry = {
			id: `mem-${this.now()}`,
			text,
			scope: readString(input, "scope") ?? "project",
			tags: readStringArray(input, "tags"),
			createdAt: this.now(),
		};
		this.entries.push(entry);
		await this.persistStore();
		return {
			target: "memory://session-grounding",
			op: "retain",
			id: entry.id,
			scope: entry.scope,
			tags: entry.tags,
			storePath: this.storePath,
		};
	}

	async recall(input: unknown): Promise<SessionGroundingRecallResult> {
		await this.loadStore();
		const query = readString(input, "query") ?? readString(input, "q") ?? "";
		const limit = Math.max(1, Math.min(100, Number(isRecord(input) ? input.limit : undefined) || 10));
		const matches = this.entries
			.map((entry) => ({ score: scoreEntry(entry, query), entry }))
			.filter((match) => match.score > 0)
			.sort((left, right) => right.score - left.score || right.entry.createdAt - left.entry.createdAt)
			.slice(0, limit)
			.map((match) => ({ score: match.score, ...match.entry }));
		return {
			target: "memory://session-grounding",
			op: "recall",
			query,
			matches,
		};
	}

	async reflect(input: unknown): Promise<SessionGroundingReflectResult> {
		const recalled = await this.recall(input);
		const matches = Array.isArray(recalled.matches) ? recalled.matches : [];
		return {
			...recalled,
			op: "reflect",
			summary:
				matches.length === 0
					? "No retained memories matched the query."
					: matches
							.map((match, index) => (isRecord(match) ? `${index + 1}. ${String(match.text ?? "")}` : undefined))
							.filter(Boolean)
							.join("\n"),
		};
	}

	private async loadStore(): Promise<void> {
		try {
			const raw = await readFile(this.storePath, "utf-8");
			this.entries = raw
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as SessionGroundingMemoryEntry)
				.filter((entry) => typeof entry.id === "string" && typeof entry.text === "string");
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") {
				this.entries = [];
				return;
			}
			throw error;
		}
	}

	private async persistStore(): Promise<void> {
		await mkdir(dirname(this.storePath), { recursive: true });
		const content = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
		await writeFile(this.storePath, content ? `${content}\n` : "");
	}
}
