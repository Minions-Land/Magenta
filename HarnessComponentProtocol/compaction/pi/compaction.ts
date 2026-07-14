import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	Models,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../_magenta/messages/messages.ts";
import { buildSessionContext } from "../../_magenta/session/pi/session.ts";
import {
	type CompactionEntry,
	CompactionError,
	err,
	ok,
	type Result,
	type SessionTreeEntry,
} from "../../_magenta/types/types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export type CompactionDetails = {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
};
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionTreeEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content as string | (TextContent | ImageContent)[],
			entry.display,
			entry.details,
			entry.timestamp,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export type CompactionResult<T = unknown> = {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Estimated context tokens after compaction, when the caller computes it. */
	estimatedTokensAfter?: number;
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
};

/** Exact progress through the serialized input being summarized. */
export type CompactionProgress = {
	phase: "summarizing";
	/** UTF-8 input bytes fully incorporated into completed summary chunks. */
	processedBytes: number;
	/** Total UTF-8 input bytes that must be summarized. */
	totalBytes: number;
	/** Number of completed provider summary chunks across all summary streams. */
	completedChunks: number;
};

export type CompactionProgressCallback = (progress: CompactionProgress) => void;

/** Compaction thresholds and retention settings. */
export type CompactionSettings = {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Optional upper bound on the used fraction of the model context window. */
	maxContextFraction?: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
};

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export type ContextUsageEstimate = {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
};

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	let threshold = contextWindow - settings.reserveTokens;
	const fraction = settings.maxContextFraction;
	if (typeof fraction === "number" && Number.isFinite(fraction) && fraction > 0 && fraction <= 1) {
		threshold = Math.min(threshold, Math.floor(contextWindow * fraction));
	}
	return contextTokens > threshold;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
function findValidCutPoints(entries: SessionTreeEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "active_tools_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
			case "leaf":
				break;
		}
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: SessionTreeEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export type CutPointResult = {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
};

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: SessionTreeEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Complete a summarization request, optionally streaming.
 *
 * When `streamFn` is provided, the request is routed through it so callers can
 * observe streamed reasoning/output; the final `AssistantMessage` is awaited via
 * `stream.result()`. When absent, the provider's non-streaming `completeSimple`
 * is used. This keeps harness compaction provider-agnostic while still supporting
 * streaming transports supplied by the caller.
 */
async function completeSummarization(
	models: Models,
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) {
		return models.completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
}

const SUMMARY_CONTEXT_SAFETY_RATIO = 0.05;
const MIN_SUMMARY_SAFETY_TOKENS = 64;

function summaryInputByteBudget(model: Model<any>, maxTokens: number): number {
	if (!(model.contextWindow > 0)) return Number.POSITIVE_INFINITY;
	const safetyTokens = Math.max(
		MIN_SUMMARY_SAFETY_TOKENS,
		Math.floor(model.contextWindow * SUMMARY_CONTEXT_SAFETY_RATIO),
	);
	// UTF-8 bytes are a deliberately conservative proxy for tokens. Keeping the
	// byte count below the token allowance also covers CJK, JSON, and signatures,
	// where the usual chars/4 heuristic can undercount badly.
	return Math.max(1, model.contextWindow - maxTokens - safetyTokens);
}

function takeUtf8Prefix(text: string, maxBytes: number): { chunk: string; rest: string } {
	if (!Number.isFinite(maxBytes) || Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { chunk: text, rest: "" };
	}

	let bytes = 0;
	let index = 0;
	let lastParagraphBoundary = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		index += character.length;
		if (character === "\n") lastParagraphBoundary = index;
	}

	// Prefer a recent paragraph boundary, but do not throw away more than half of
	// the available chunk just to find one.
	const cutIndex = lastParagraphBoundary >= Math.floor(index / 2) ? lastParagraphBoundary : index;
	return { chunk: text.slice(0, cutIndex), rest: text.slice(cutIndex) };
}

function buildSummaryPrompt(conversationText: string, instructions: string, previousSummary?: string): string {
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary !== undefined) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	return promptText + instructions;
}

type IncrementalSummaryOptions = {
	conversationText: string;
	models: Models;
	model: Model<any>;
	maxTokens: number;
	initialInstructions: string;
	updateInstructions: string;
	previousSummary?: string;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	errorPrefix: string;
	onProgress?: (progress: { processedBytes: number; totalBytes: number; completedChunks: number }) => void;
};

async function generateIncrementalSummary(
	options: IncrementalSummaryOptions,
): Promise<Result<string, CompactionError>> {
	let remaining = options.conversationText;
	let rollingSummary = options.previousSummary;
	let hasSummary = options.previousSummary !== undefined;
	let completedChunks = 0;
	const inputBudget = summaryInputByteBudget(options.model, options.maxTokens);
	const totalBytes = Buffer.byteLength(options.conversationText, "utf8");
	options.onProgress?.({ processedBytes: 0, totalBytes, completedChunks: 0 });

	do {
		const instructions = hasSummary ? options.updateInstructions : options.initialInstructions;
		const promptWithoutConversation = buildSummaryPrompt("", instructions, hasSummary ? rollingSummary : undefined);
		const fixedBytes =
			Buffer.byteLength(SUMMARIZATION_SYSTEM_PROMPT, "utf8") + Buffer.byteLength(promptWithoutConversation, "utf8");
		const conversationBudget = inputBudget - fixedBytes;
		if (conversationBudget <= 0) {
			return err(
				new CompactionError(
					"summarization_failed",
					`${options.errorPrefix} failed: summary instructions and prior summary exceed the model context window`,
				),
			);
		}

		const { chunk, rest } = takeUtf8Prefix(remaining, conversationBudget);
		if (remaining.length > 0 && chunk.length === 0) {
			return err(
				new CompactionError(
					"summarization_failed",
					`${options.errorPrefix} failed: unable to fit conversation content in the model context window`,
				),
			);
		}

		const promptText = buildSummaryPrompt(chunk, instructions, hasSummary ? rollingSummary : undefined);
		const summarizationMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];
		const completionOptions =
			options.model.reasoning && options.thinkingLevel && options.thinkingLevel !== "off"
				? {
						maxTokens: options.maxTokens,
						signal: options.signal,
						reasoning: options.thinkingLevel,
					}
				: { maxTokens: options.maxTokens, signal: options.signal };
		const response = await completeSummarization(
			options.models,
			options.model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
			completionOptions,
			options.streamFn,
		);
		if (response.stopReason === "aborted") {
			return err(new CompactionError("aborted", response.errorMessage || `${options.errorPrefix} aborted`));
		}
		if (response.stopReason === "error") {
			return err(
				new CompactionError(
					"summarization_failed",
					`${options.errorPrefix} failed: ${response.errorMessage || "Unknown error"}`,
				),
			);
		}

		rollingSummary = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		hasSummary = true;
		remaining = rest;
		completedChunks++;
		options.onProgress?.({
			processedBytes: totalBytes - Buffer.byteLength(remaining, "utf8"),
			totalBytes,
			completedChunks,
		});
	} while (remaining.length > 0 || completedChunks === 0);

	return ok(rollingSummary ?? "");
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	onProgress?: (progress: { processedBytes: number; totalBytes: number; completedChunks: number }) => void,
): Promise<Result<string, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);
	const updatePrompt = customInstructions
		? `${UPDATE_SUMMARIZATION_PROMPT}\n\nAdditional focus: ${customInstructions}`
		: UPDATE_SUMMARIZATION_PROMPT;
	return generateIncrementalSummary({
		conversationText,
		models,
		model,
		maxTokens,
		initialInstructions: basePrompt,
		updateInstructions: updatePrompt,
		previousSummary,
		signal,
		thinkingLevel,
		streamFn,
		errorPrefix: "Summarization",
		onProgress,
	});
}

/** Prepared inputs for a compaction run. */
export type CompactionPreparation = {
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Messages summarized into the history summary. */
	messagesToSummarize: AgentMessage[];
	/** Prefix messages summarized separately when compaction splits a turn. */
	turnPrefixMessages: AgentMessage[];
	/** Whether compaction splits a turn. */
	isSplitTurn: boolean;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Previous compaction summary used for iterative updates. */
	previousSummary?: string;
	/** File operations extracted from summarized history. */
	fileOps: FileOperations;
	/** Settings used to prepare compaction. */
	settings: CompactionSettings;
};

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: SessionTreeEntry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	// Nothing to summarize (e.g. a prior compaction already covered these entries
	// and the kept window still fits): compaction is not applicable.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return ok(undefined);
	}

	return ok({
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

const UPDATE_TURN_PREFIX_SUMMARIZATION_PROMPT = `The conversation contains another chunk from the same split-turn prefix.
Update the existing turn-prefix summary in <previous-summary> with the new information.

Keep this exact format:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the kept suffix]

Preserve important file paths, decisions, errors, and unfinished work. Be concise.`;

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export async function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<any>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	onProgress?: CompactionProgressCallback,
): Promise<Result<CompactionResult, CompactionError>> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	if (!firstKeptEntryId) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}

	let summary: string;
	const summaryProgress = new Map<
		"history" | "turnPrefix",
		{ processedBytes: number; totalBytes: number; completedChunks: number }
	>();
	const reportProgress = (
		key: "history" | "turnPrefix",
		progress: { processedBytes: number; totalBytes: number; completedChunks: number },
	): void => {
		summaryProgress.set(key, progress);
		const values = [...summaryProgress.values()];
		onProgress?.({
			phase: "summarizing",
			processedBytes: values.reduce((total, value) => total + value.processedBytes, 0),
			totalBytes: values.reduce((total, value) => total + value.totalBytes, 0),
			completedChunks: values.reduce((total, value) => total + value.completedChunks, 0),
		});
	};

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		if (messagesToSummarize.length === 0) {
			summaryProgress.set("history", { processedBytes: 0, totalBytes: 0, completedChunks: 0 });
		}
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						models,
						model,
						settings.reserveTokens,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
						(progress) => reportProgress("history", progress),
					)
				: Promise.resolve(ok<string, CompactionError>("No prior history.")),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				models,
				model,
				settings.reserveTokens,
				signal,
				thinkingLevel,
				streamFn,
				(progress) => reportProgress("turnPrefix", progress),
			),
		]);
		if (!historyResult.ok) return err(historyResult.error);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
	} else {
		const summaryResult = await generateSummary(
			messagesToSummarize,
			models,
			model,
			settings.reserveTokens,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			(progress) => reportProgress("history", progress),
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value;
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	});
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	onProgress?: (progress: { processedBytes: number; totalBytes: number; completedChunks: number }) => void,
): Promise<Result<string, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	return generateIncrementalSummary({
		conversationText,
		models,
		model,
		maxTokens,
		initialInstructions: TURN_PREFIX_SUMMARIZATION_PROMPT,
		updateInstructions: UPDATE_TURN_PREFIX_SUMMARIZATION_PROMPT,
		signal,
		thinkingLevel,
		streamFn,
		errorPrefix: "Turn prefix summarization",
		onProgress,
	});
}
