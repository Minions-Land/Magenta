import type { AssistantMessage, Context, Message, Model, Api } from "../types.ts";

/**
 * Compute a context-aware maxTokens cap that fits within the model's context
 * window, accounting for estimated input size and a small reserve.
 *
 * Used by streamSimple to share the contextWindow budget between input and output.
 *
 * @param context - The request context (system prompt, messages, tools).
 * @param model - The model with contextWindow and maxTokens.
 * @returns A maxTokens value capped to fit input + output + reserve within contextWindow.
 */
export function estimateMaxOutputTokens<TApi extends Api>(context: Context, model: Model<TApi>): number {
	// Rough token estimator: 1 token ≈ 4 chars (common for English text).
	// This is a conservative heuristic; real tokenization varies by model.
	const CHARS_PER_TOKEN = 4;
	const RESERVE_TOKENS = 256; // Small buffer for encoding overhead.

	let charCount = 0;

	// System prompt.
	if (context.systemPrompt) {
		charCount += context.systemPrompt.length;
	}

	// Messages.
	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				charCount += msg.content.length;
			} else {
				for (const block of msg.content) {
					if (block.type === "text") {
						charCount += block.text.length;
					} else if (block.type === "image") {
						// Images vary widely; rough estimate: 256–1024 tokens per image.
						charCount += 256 * CHARS_PER_TOKEN;
					}
				}
			}
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text") {
					charCount += block.text.length;
				} else if (block.type === "thinking") {
					charCount += block.thinking.length;
				} else if (block.type === "toolCall") {
					charCount += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
		} else if (msg.role === "toolResult") {
			for (const block of msg.content) {
				if (block.type === "text") {
					charCount += block.text.length;
				} else if (block.type === "image") {
					charCount += 256 * CHARS_PER_TOKEN;
				}
			}
		}
	}

	// Tools.
	if (context.tools) {
		for (const tool of context.tools) {
			charCount += tool.name.length + tool.description.length;
			charCount += JSON.stringify(tool.parameters).length;
		}
	}

	const estimatedInputTokens = Math.ceil(charCount / CHARS_PER_TOKEN) + RESERVE_TOKENS;
	const availableOutputTokens = model.contextWindow - estimatedInputTokens;

	// Clamp to model's maxTokens and ensure at least a small minimum.
	const MIN_OUTPUT_TOKENS = 256;
	return Math.max(MIN_OUTPUT_TOKENS, Math.min(model.maxTokens, availableOutputTokens));
}

/**
 * Retrieve the last assistant message's usage info from the message array,
 * ignoring any assistant usage that appears before a newer user message
 * (indicating stale usage from before a prefix insertion, e.g., a compaction
 * summary). Returns both the usage and its message index.
 *
 * This is a pi/ai-scoped helper. It does NOT collide with or replace the
 * harness `getLastAssistantUsage`, which operates on a different data structure
 * (harness SessionTreeEntry) and is consumed by coding-agent compaction logic.
 *
 * @param messages - The message array to scan.
 * @returns The usage info and index from the last valid assistant message, or undefined.
 */
export function getLastAssistantUsageInfo(
	messages: readonly Message[],
): { usage: AssistantMessage["usage"]; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && msg.usage) {
			// Check if there's a newer user message after this assistant message.
			// If so, this assistant's usage is stale (reflects pre-insertion context).
			let hasNewerUser = false;
			for (let j = i + 1; j < messages.length; j++) {
				if (messages[j].role === "user") {
					hasNewerUser = true;
					break;
				}
			}
			if (hasNewerUser) {
				// Skip this assistant message; its usage is stale.
				continue;
			}
			return { usage: msg.usage, index: i };
		}
	}
	return undefined;
}
