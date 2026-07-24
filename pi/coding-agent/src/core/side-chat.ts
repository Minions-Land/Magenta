import type { AssistantMessage, Message, Models, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple as compatCompleteSimple } from "@earendil-works/pi-ai/compat";
import { uuidv7 } from "@magenta/harness";
import { CENTER_FLOATING_OVERLAY } from "../modes/interactive/components/floating-window.ts";
import {
	type SideChatItem,
	SideChatOverlay,
	type SideChatOverlayResult,
} from "../modes/interactive/components/side-chat-overlay.ts";
import { copyToClipboard } from "../utils/clipboard.ts";
import { truncateModelText } from "./background-shell-utils.ts";
import type { ExtensionCommandContext } from "./extensions/types.ts";
import type { CustomEntry, ReadonlySessionManager } from "./session-manager.ts";
import type { ToolProgressTracker } from "./tool-progress.ts";

export const SIDE_CHAT_COMMAND_NAMES = ["side", "btw", "s"] as const;
export const SIDE_CHAT_SESSION_CUSTOM_TYPE = "magenta-side-chat.v1";
export const SIDE_CHAT_HANDOFF_MAX_BYTES = 16 * 1024;

const SIDE_CHAT_MESSAGE_MAX_BYTES = 64 * 1024;
const SIDE_CHAT_MODEL_HISTORY_MAX_BYTES = 48 * 1024;
const NEW_CONVERSATION_OPTION = "+ New side/btw conversation";
const SIDE_CHAT_SHORTENED_MARKER = "\n\n[Side/BTW content shortened to fit the retained context budget.]\n\n";

const SYSTEM_PROMPT = `You are a persistent side-chat agent embedded inside Magenta.

Purpose:
- Explain concepts, clarify trade-offs, answer side questions, and help the user think.
- Stay lightweight and conversational.

Constraints:
- You have no tools and cannot execute commands, inspect files, or modify anything.
- Do not claim that you performed actions. If execution or code inspection is needed, tell the user to ask the main agent.
- Keep answers concise unless the user asks for detail.
- Use the provided recent main conversation context only as background.
- You may also receive a live snapshot of the main agent's current/recent tool executions. Treat it as observational context, not as work you performed.`;

export type SideChatKind = "side" | "btw";

export type SideChatHandoffRequest = {
	confirmed: true;
	origin: SideChatKind;
	conversationId: string;
	label: string;
	context: string;
	messageCount: number;
	originalBytes: number;
	truncated: boolean;
};

export type SideChatHandoffResult = {
	handoffId: string;
	sessionId: string;
};

type SideChatCreatedEvent = {
	version: 1;
	action: "created";
	conversationId: string;
	kind: SideChatKind;
	createdAt: number;
	modelLabel: string;
};

type SideChatMessageEvent = {
	version: 1;
	action: "message";
	conversationId: string;
	role: "user" | "assistant";
	text: string;
	at: number;
};

type SideChatEnqueuedEvent = {
	version: 1;
	action: "enqueued";
	conversationId: string;
	handoffId: string;
	sessionId: string;
	at: number;
};

export type SideChatPersistenceEvent = SideChatCreatedEvent | SideChatMessageEvent | SideChatEnqueuedEvent;

export type SideChatConversation = {
	id: string;
	kind: SideChatKind;
	createdAt: number;
	updatedAt: number;
	modelLabel: string;
	messages: Array<{ role: "user" | "assistant"; text: string }>;
	persisted: boolean;
	handoff?: { handoffId: string; sessionId: string; at: number };
};

type SideChatManagerOptions = {
	toolProgress: ToolProgressTracker;
	/** Session-owned completion path. Defaults to compat for external callers during migration. */
	completeSimple?: Models["completeSimple"];
	appendEntry?: (customType: string, data: SideChatPersistenceEvent) => void;
	enqueueHumanHandoff?: (
		request: SideChatHandoffRequest,
		ctx: ExtensionCommandContext,
	) => Promise<SideChatHandoffResult>;
	copyText?: (text: string) => Promise<void>;
	createConversationId?: () => string;
};

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function recentConversationContext(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getBranch();
	const sections: string[] = [];

	for (let i = Math.max(0, entries.length - 16); i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = extractText(message.content).trim();
		if (!text) continue;
		sections.push(`${message.role === "user" ? "User" : "Main assistant"}: ${text}`);
	}

	const context = sections.join("\n\n");
	return truncateModelText(context, 12_000, SIDE_CHAT_SHORTENED_MARKER).text;
}

function isPersistenceEvent(value: unknown): value is SideChatPersistenceEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<SideChatPersistenceEvent> & Record<string, unknown>;
	if (event.version !== 1 || typeof event.conversationId !== "string") return false;
	if (event.action === "created") {
		return (
			(event.kind === "side" || event.kind === "btw") &&
			typeof event.createdAt === "number" &&
			typeof event.modelLabel === "string"
		);
	}
	if (event.action === "message") {
		return (
			(event.role === "user" || event.role === "assistant") &&
			typeof event.text === "string" &&
			typeof event.at === "number"
		);
	}
	if (event.action === "enqueued") {
		return typeof event.handoffId === "string" && typeof event.sessionId === "string" && typeof event.at === "number";
	}
	return false;
}

export function loadSideChatConversations(sessionManager: ReadonlySessionManager): SideChatConversation[] {
	const conversations = new Map<string, SideChatConversation>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== SIDE_CHAT_SESSION_CUSTOM_TYPE) continue;
		const event = (entry as CustomEntry).data;
		if (!isPersistenceEvent(event)) continue;
		if (event.action === "created") {
			if (conversations.has(event.conversationId)) continue;
			conversations.set(event.conversationId, {
				id: event.conversationId,
				kind: event.kind,
				createdAt: event.createdAt,
				updatedAt: event.createdAt,
				modelLabel: event.modelLabel,
				messages: [],
				persisted: true,
			});
			continue;
		}
		const conversation = conversations.get(event.conversationId);
		if (!conversation) continue;
		if (event.action === "message") {
			conversation.messages.push({ role: event.role, text: event.text });
			conversation.updatedAt = Math.max(conversation.updatedAt, event.at);
		} else {
			conversation.handoff = {
				handoffId: event.handoffId,
				sessionId: event.sessionId,
				at: event.at,
			};
			conversation.updatedAt = Math.max(conversation.updatedAt, event.at);
		}
	}
	return [...conversations.values()]
		.filter((conversation) => conversation.messages.length > 0 || conversation.handoff)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

function conversationSummary(conversation: SideChatConversation): string {
	const first = conversation.messages.find((message) => message.role === "user")?.text ?? "(empty conversation)";
	const normalized = first.replace(/\s+/g, " ").trim();
	return Array.from(normalized).slice(0, 52).join("") || "(empty conversation)";
}

function historyOption(conversation: SideChatConversation): string {
	const stamp = new Date(conversation.updatedAt).toISOString().slice(0, 16).replace("T", " ");
	const queued = conversation.handoff ? ` · queued ${conversation.handoff.sessionId}` : "";
	return `${conversation.kind} · ${conversationSummary(conversation)} · ${stamp}${queued} · ${conversation.id.slice(-6)}`;
}

function retainedSideMessages(messages: SideChatConversation["messages"]): SideChatConversation["messages"] {
	const retained: SideChatConversation["messages"] = [];
	let bytes = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		const nextBytes = Buffer.byteLength(message.text, "utf8") + 32;
		if (retained.length > 0 && bytes + nextBytes > SIDE_CHAT_MODEL_HISTORY_MAX_BYTES) break;
		retained.push(message);
		bytes += nextBytes;
	}
	return retained.reverse();
}

function toModelMessage(message: SideChatConversation["messages"][number]): UserMessage | AssistantMessage {
	return {
		role: message.role,
		content: [{ type: "text", text: message.text }],
		timestamp: Date.now(),
	} as UserMessage | AssistantMessage;
}

export function buildSideChatHandoffSnapshot(
	conversation: SideChatConversation,
): Omit<SideChatHandoffRequest, "confirmed" | "label"> {
	const transcript = conversation.messages
		.map((message) => `${message.role === "user" ? "Human" : "Side assistant"}: ${message.text}`)
		.join("\n\n");
	const originalBytes = Buffer.byteLength(transcript, "utf8");
	const bounded = truncateModelText(transcript, SIDE_CHAT_HANDOFF_MAX_BYTES, SIDE_CHAT_SHORTENED_MARKER);
	return {
		origin: conversation.kind,
		conversationId: conversation.id,
		context: bounded.text,
		messageCount: conversation.messages.length,
		originalBytes,
		truncated: bounded.truncated,
	};
}

export class SideChatManager {
	private readonly toolProgress: ToolProgressTracker;
	private readonly completeSimple: Models["completeSimple"];
	private readonly appendEntry?: SideChatManagerOptions["appendEntry"];
	private readonly enqueueHumanHandoff?: SideChatManagerOptions["enqueueHumanHandoff"];
	private readonly copyText: (text: string) => Promise<void>;
	private readonly createConversationId: () => string;

	constructor(options: SideChatManagerOptions) {
		this.toolProgress = options.toolProgress;
		this.completeSimple = options.completeSimple ?? compatCompleteSimple;
		this.appendEntry = options.appendEntry;
		this.enqueueHumanHandoff = options.enqueueHumanHandoff;
		this.copyText = options.copyText ?? copyToClipboard;
		this.createConversationId = options.createConversationId ?? uuidv7;
	}

	async handleCommand(commandName: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!SIDE_CHAT_COMMAND_NAMES.includes(commandName as (typeof SIDE_CHAT_COMMAND_NAMES)[number])) return;
		await this.open(commandName === "btw" ? "btw" : "side", args, ctx);
	}

	async open(kind: SideChatKind, args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/side requires interactive TUI mode", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const model = ctx.model;
		const modelLabel = `${model.provider}/${model.id}`;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(auth.ok ? `No API key for ${model.provider}` : auth.error, "error");
			return;
		}

		const histories = loadSideChatConversations(ctx.sessionManager);
		const optionMap = new Map(histories.map((conversation) => [historyOption(conversation), conversation]));
		const selected = await ctx.ui.select("Side / BTW history", [NEW_CONVERSATION_OPTION, ...optionMap.keys()]);
		if (!selected) return;
		const conversation =
			selected === NEW_CONVERSATION_OPTION
				? {
						id: this.createConversationId(),
						kind,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						modelLabel,
						messages: [],
						persisted: false,
					}
				: optionMap.get(selected);
		if (!conversation) return;

		let initialQuestion = args.trim();
		let draft = "";
		for (;;) {
			const outcome = await this.openConversation(
				conversation,
				ctx,
				modelLabel,
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
				initialQuestion,
				draft,
			);
			initialQuestion = "";
			draft = outcome.draft;
			if (outcome.action === "close") return;

			if (!this.enqueueHumanHandoff) {
				ctx.ui.notify("Managed teammate handoff is unavailable in this runtime", "error");
				continue;
			}
			const confirmed = await ctx.ui.confirm(
				"Enqueue Side / BTW as teammate?",
				"Create a persistent teammate Session from this conversation. It will send Main its understanding and questions before broad action; no Assignment or file lease is created.",
			);
			if (!confirmed) continue;

			try {
				const snapshot = buildSideChatHandoffSnapshot(conversation);
				const result = await this.enqueueHumanHandoff(
					{
						...snapshot,
						confirmed: true,
						label: `${conversation.kind} · ${conversationSummary(conversation).slice(0, 36)}`,
					},
					ctx,
				);
				const at = Date.now();
				conversation.handoff = { ...result, at };
				conversation.updatedAt = at;
				this.persist({
					version: 1,
					action: "enqueued",
					conversationId: conversation.id,
					...result,
					at,
				});
				ctx.ui.notify(`Enqueued as Session ${result.sessionId}; waiting for its message to Main.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
	}

	private async openConversation(
		conversation: SideChatConversation,
		ctx: ExtensionCommandContext,
		modelLabel: string,
		auth: { apiKey: string; headers?: Record<string, string>; env?: Record<string, string> },
		initialQuestion: string,
		draft: string,
	): Promise<SideChatOverlayResult> {
		const model = ctx.model!;
		const send = async (text: string, signal: AbortSignal) => {
			this.ensureCreated(conversation, modelLabel);
			const persistedQuestion = truncateModelText(
				text,
				SIDE_CHAT_MESSAGE_MAX_BYTES,
				SIDE_CHAT_SHORTENED_MARKER,
			).text;
			const priorMessages = retainedSideMessages(conversation.messages);
			const messages: Message[] = [];
			const context = recentConversationContext(ctx);
			if (context) {
				messages.push({
					role: "user",
					content: [{ type: "text", text: `Recent main conversation context for background only:\n\n${context}` }],
					timestamp: Date.now(),
				} as UserMessage);
			}
			messages.push(...priorMessages.map(toModelMessage));
			const progress = this.toolProgress.format();
			messages.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `Current main-agent tool progress snapshot:\n\n${progress}\n\nSide-chat question:\n${persistedQuestion}`,
					},
				],
				timestamp: Date.now(),
			} as UserMessage);
			this.appendMessage(conversation, "user", persistedQuestion);

			const response = await this.completeSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
			);
			const textParts = response.content.filter((part): part is TextContent => part.type === "text");
			const answer = textParts.map((part) => part.text).join("\n");
			const persistedAnswer = truncateModelText(
				answer,
				SIDE_CHAT_MESSAGE_MAX_BYTES,
				SIDE_CHAT_SHORTENED_MARKER,
			).text;
			this.appendMessage(conversation, "assistant", persistedAnswer);
			return persistedAnswer;
		};

		return ctx.ui.custom<SideChatOverlayResult>(
			(tui, theme, _keybindings, done) =>
				new SideChatOverlay(tui, theme, done, send, {
					initialQuestion,
					initialMessages: conversation.messages.map((message): SideChatItem => ({ ...message })),
					modelLabel,
					enqueuedSessionId: conversation.handoff?.sessionId,
					onCopy: this.copyText,
					initialDraft: draft,
				}),
			{
				overlay: true,
				onHandle: (handle) => handle.focus(),
				overlayOptions: CENTER_FLOATING_OVERLAY,
			},
		);
	}

	private ensureCreated(conversation: SideChatConversation, modelLabel: string): void {
		if (conversation.persisted) return;
		conversation.persisted = true;
		this.persist({
			version: 1,
			action: "created",
			conversationId: conversation.id,
			kind: conversation.kind,
			createdAt: conversation.createdAt,
			modelLabel,
		});
	}

	private appendMessage(conversation: SideChatConversation, role: "user" | "assistant", text: string): void {
		const at = Date.now();
		conversation.messages.push({ role, text });
		conversation.updatedAt = at;
		this.persist({ version: 1, action: "message", conversationId: conversation.id, role, text, at });
	}

	private persist(event: SideChatPersistenceEvent): void {
		this.appendEntry?.(SIDE_CHAT_SESSION_CUSTOM_TYPE, event);
	}
}
