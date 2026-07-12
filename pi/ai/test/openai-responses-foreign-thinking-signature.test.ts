import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Usage } from "../src/types.ts";

/**
 * Regression: convertResponsesMessages replays OpenAI reasoning items by
 * JSON.parse-ing a thinking block's `thinkingSignature` (OpenAI writes it as
 * JSON.stringify(item)). This used to be a bare JSON.parse with no error
 * handling, so any signature that is not valid JSON threw a SyntaxError during
 * request construction — before any network call — surfacing to the user as a
 * hard "request" error on the very first input (not a timeout).
 *
 * Note on the reachable path: transformMessages keeps `thinkingSignature` only
 * for same-model turns (provider + api + model all match the target); a
 * cross-provider thinking block is downgraded to plain text and loses its
 * signature before this code runs. So the signature that reaches JSON.parse is
 * always a same-model one — but it can still be non-JSON: a stale or truncated
 * signature from an older session, a foreign (e.g. base64) signature, or a
 * format change across versions. The fix guards the parse with try/catch so a
 * bad signature drops just the reasoning item instead of tearing down the whole
 * request.
 */

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// A non-JSON signature (base64-shaped), representative of a foreign/stale value.
const NON_JSON_SIGNATURE = "Qf60tk4G9u5Ewh2/NioZWQ==";

describe("OpenAI Responses non-JSON thinking signature handling", () => {
	function sameModelContextWithBadSignature(): { model: NonNullable<ReturnType<typeof getModel>>; context: Context } {
		const model = getModel("openai", "gpt-5-mini");
		if (!model) throw new Error("expected openai/gpt-5-mini model");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				// Same-model signature that survives transformMessages, but is not JSON.
				{ type: "thinking", thinking: "Let me reason.", thinkingSignature: NON_JSON_SIGNATURE },
				{ type: "text", text: "Here is my answer." },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() - 2000 },
				assistant,
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};
		return { model, context };
	}

	it("does not throw when a thinking signature is not valid JSON", () => {
		const { model, context } = sameModelContextWithBadSignature();
		expect(() => convertResponsesMessages(model, context, new Set(["openai"]))).not.toThrow();
	});

	it("drops the unparseable reasoning item but keeps the rest of the turn", () => {
		const { model, context } = sameModelContextWithBadSignature();
		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		// No reasoning item is emitted from the bad signature.
		expect(input.some((item) => item.type === "reasoning")).toBe(false);
		// The assistant's text content still survives the turn.
		const assistantText = input.find(
			(item) => item.type === "message" && (item as { role?: string }).role === "assistant",
		);
		expect(assistantText).toBeDefined();
	});

	it("still replays a valid JSON reasoning signature", () => {
		const model = getModel("openai", "gpt-5-mini");
		if (!model) throw new Error("expected openai/gpt-5-mini model");
		const reasoningItem = { type: "reasoning", id: "rs_test123", summary: [] };
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "ok", thinkingSignature: JSON.stringify(reasoningItem) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() - 2000 },
				assistant,
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};
		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(input.some((item) => item.type === "reasoning")).toBe(true);
	});

	it("safely downgrades a cross-provider (Anthropic) thinking block without throwing", () => {
		// Sanity check for the other layer of defense: a thinking block from a
		// different provider never even reaches this parse. transformMessages
		// downgrades it to plain text and drops the (base64, non-JSON) signature
		// before convertResponsesMessages iterates the blocks. Request construction
		// must not throw, and no reasoning item should be replayed from it.
		const model = getModel("openai", "gpt-5-mini");
		if (!model) throw new Error("expected openai/gpt-5-mini model");
		const anthropicAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Reasoning on Claude.", thinkingSignature: NON_JSON_SIGNATURE },
				{ type: "text", text: "Answer from Claude." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() - 2000 },
				anthropicAssistant,
				{ role: "user", content: "Continue on OpenAI", timestamp: Date.now() },
			],
		};
		let input!: ReturnType<typeof convertResponsesMessages>;
		expect(() => {
			input = convertResponsesMessages(model, context, new Set(["openai"]));
		}).not.toThrow();
		expect(input.some((item) => item.type === "reasoning")).toBe(false);
	});
});
