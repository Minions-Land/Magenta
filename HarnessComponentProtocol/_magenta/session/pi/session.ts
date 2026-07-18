import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../messages/messages.ts";
import type {
	ActiveToolsChangeEntry,
	BranchSummaryEntry,
	CompactionEntry,
	ContextEntryTransform,
	CustomEntry,
	CustomEntryContextMessageProjector,
	CustomMessageEntry,
	LabelEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionContext,
	SessionContextBuildOptions,
	SessionInfoEntry,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../../types/types.ts";
import { SessionError } from "../../types/types.ts";

/**
 * Default context entry transform: from the full active branch, select the latest compaction and
 * keep the compaction marker followed by entries from its `firstKeptEntryId` onward, then any
 * entries appended after the compaction. Without a compaction the sequence is returned unchanged.
 */
export function defaultContextEntryTransform(pathEntries: SessionTreeEntry[]): SessionTreeEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "compaction") compaction = entry;
	}
	if (!compaction) return [...pathEntries];
	const compactionIdx = pathEntries.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
	const selected: SessionTreeEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = pathEntries[i]!;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) selected.push(entry);
	}
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		selected.push(pathEntries[i]!);
	}
	return selected;
}

/**
 * Project a single session entry into model messages. `custom` entries produce no messages unless a
 * keyed projector for their `customType` returns messages; state-only entries produce nothing.
 */
export function sessionEntryToContextMessages(
	entry: SessionTreeEntry,
	projectors?: Record<string, CustomEntryContextMessageProjector>,
): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return [entry.message as AgentMessage];
		case "custom_message":
			return [
				createCustomMessage(
					entry.customType,
					entry.content as string | (TextContent | ImageContent)[],
					entry.display,
					entry.details,
					entry.timestamp,
				) as AgentMessage,
			];
		case "branch_summary":
			return entry.summary
				? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp) as AgentMessage]
				: [];
		case "compaction":
			return [
				createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp) as AgentMessage,
			];
		case "custom": {
			const projector = projectors?.[entry.customType];
			return projector ? projector(entry) : [];
		}
		default:
			return [];
	}
}

/**
 * Build the context entry sequence for the active branch: apply the default latest-compaction
 * selection, then run stacked custom transforms in order. Operates on entries, not messages.
 */
export function buildContextEntries(
	pathEntries: SessionTreeEntry[],
	options?: SessionContextBuildOptions,
): SessionTreeEntry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options?.entryTransforms ?? []) {
		entries = transform(entries);
	}
	return entries;
}

export function buildSessionContext(
	pathEntries: SessionTreeEntry[],
	options?: SessionContextBuildOptions,
): SessionContext {
	// Runtime state derives from the full active branch, before compaction selection.
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}

	const entries = buildContextEntries(pathEntries, options);
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry, options?.entryProjectors)) {
			messages.push(message);
		}
	}

	return { messages, thinkingLevel, model, activeToolNames };
}

/** Merge constructor-level and per-call build options: stack transforms, override projectors by key. */
function mergeContextBuildOptions(
	base?: SessionContextBuildOptions,
	override?: SessionContextBuildOptions,
): SessionContextBuildOptions | undefined {
	if (!base) return override;
	if (!override) return base;
	return {
		entryTransforms: [...(base.entryTransforms ?? []), ...(override.entryTransforms ?? [])],
		entryProjectors: { ...(base.entryProjectors ?? {}), ...(override.entryProjectors ?? {}) },
	};
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private storage: SessionStorage<TMetadata>;
	private readonly buildOptions?: SessionContextBuildOptions;

	constructor(storage: SessionStorage<TMetadata>, buildOptions?: SessionContextBuildOptions) {
		this.storage = storage;
		this.buildOptions = buildOptions;
	}

	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	getStorage(): SessionStorage<TMetadata> {
		return this.storage;
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	getEntries(): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries();
	}

	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const leafId = fromId ?? (await this.storage.getLeafId());
		return this.storage.getPathToRoot(leafId);
	}

	async buildContext(options?: SessionContextBuildOptions): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), mergeContextBuildOptions(this.buildOptions, options));
	}

	/**
	 * Build the context entry sequence for the active branch (default compaction selection plus
	 * stacked transforms), without projecting to messages. Constructor and per-call options stack.
	 */
	async buildContextEntries(options?: SessionContextBuildOptions): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), mergeContextBuildOptions(this.buildOptions, options));
	}

	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	async getSessionName(): Promise<string | undefined> {
		const entries = await this.storage.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}

	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.storage.appendEntry(entry);
		return entry.id;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		} satisfies ThinkingLevelChangeEntry);
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		} satisfies ModelChangeEntry);
	}

	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry({
			type: "active_tools_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			activeToolNames: [...activeToolNames],
		} satisfies ActiveToolsChangeEntry);
	}

	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.storage.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		} satisfies LabelEntry);
	}

	async appendSessionName(name: string): Promise<string> {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry({
			type: "session_info",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		} satisfies SessionInfoEntry);
	}

	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.storage.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		await this.storage.setLeafId(entryId);
		if (!summary) return undefined;
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.storage.createEntryId(),
			parentId: entryId,
			timestamp: new Date().toISOString(),
			fromId: entryId ?? "root",
			summary: summary.summary,
			details: summary.details,
			fromHook: summary.fromHook,
		} satisfies BranchSummaryEntry);
	}
}
