import type { AssistantMessage, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { CENTER_FLOATING_OVERLAY } from "../modes/interactive/components/floating-window.ts";
import { SideChatOverlay } from "../modes/interactive/components/side-chat-overlay.ts";
import type { ExtensionCommandContext } from "./extensions/types.ts";
import type { ToolProgressTracker } from "./tool-progress.ts";

export const SIDE_CHAT_COMMAND_NAMES = ["side", "btw", "s"] as const;

const SYSTEM_PROMPT = `You are a temporary side-chat agent embedded inside pi.

Purpose:
- Explain concepts, clarify trade-offs, answer side questions, and help the user think.
- Stay lightweight and conversational.

Constraints:
- You have no tools and cannot execute commands, inspect files, or modify anything.
- Do not claim that you performed actions. If execution or code inspection is needed, tell the user to ask the main agent.
- Keep answers concise unless the user asks for detail.
- Use the provided recent main conversation context only as background.
- You may also receive a live snapshot of the main agent's current/recent tool executions. Treat it as observational context, not as work you performed.`;

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
	return context.length > 12000 ? context.slice(-12000) : context;
}

export class SideChatManager {
	private toolProgress: ToolProgressTracker;

	constructor(options: { toolProgress: ToolProgressTracker }) {
		this.toolProgress = options.toolProgress;
	}

	async handleCommand(commandName: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!SIDE_CHAT_COMMAND_NAMES.includes(commandName as (typeof SIDE_CHAT_COMMAND_NAMES)[number])) {
			return;
		}
		await this.open(args, ctx);
	}

	async open(args: string, ctx: ExtensionCommandContext): Promise<void> {
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

		const context = recentConversationContext(ctx);
		const messages: Message[] = [];
		if (context) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: `Recent main conversation context for background only:\n\n${context}` }],
				timestamp: Date.now(),
			} as UserMessage);
		}

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const send = async (text: string, signal: AbortSignal) => {
					const progress = this.toolProgress.format();
					const userMessage: UserMessage = {
						role: "user",
						content: [
							{
								type: "text",
								text: `Current main-agent tool progress snapshot:\n\n${progress}\n\nSide-chat question:\n${text}`,
							},
						],
						timestamp: Date.now(),
					};
					messages.push(userMessage);

					const response = await completeSimple(
						model,
						{ systemPrompt: SYSTEM_PROMPT, messages },
						{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
					);

					const textParts = response.content.filter((part): part is TextContent => part.type === "text");
					const answer = textParts.map((part) => part.text).join("\n");

					// Store only the text of the reply in history. The raw response can carry
					// reasoning `thinking` blocks whose signatures reference server-side reasoning
					// items. Replaying those through the stateless completeSimple path (which does
					// not request encrypted reasoning content) makes reasoning models return only a
					// reasoning item and no message on the next turn, surfacing as "(empty response)".
					// Keeping just the text preserves conversational context without that hazard.
					messages.push({
						role: "assistant",
						content: [{ type: "text", text: answer }],
						timestamp: Date.now(),
					} as AssistantMessage);
					return answer;
				};

				return new SideChatOverlay(tui, theme, done, send, args, modelLabel);
			},
			{
				overlay: true,
				onHandle: (handle) => handle.focus(),
				overlayOptions: CENTER_FLOATING_OVERLAY,
			},
		);
	}
}
