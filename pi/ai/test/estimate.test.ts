import { describe, expect, it } from "vitest";
import { estimateMaxOutputTokens, getLastAssistantUsageInfo } from "../src/utils/estimate.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";

/**
 * AI-007 + AI-021: context-aware max-token cap and stale-usage filtering.
 */

function makeModel(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function makeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(usage: Usage, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

describe("AI-007: estimateMaxOutputTokens", () => {
	it("caps output tokens within contextWindow for long prompts", () => {
		const model = makeModel();
		// Long system prompt ~10k chars = ~2500 tokens + reserve = ~2756
		const longPrompt = "x".repeat(10000);
		const context: Context = {
			systemPrompt: longPrompt,
			messages: [{ role: "user", content: "test", timestamp: Date.now() }],
		};

		const maxOutput = estimateMaxOutputTokens(context, model);

		// Available = 200000 - 2756 = 197244, clamped to model.maxTokens = 8192
		expect(maxOutput).toBe(8192);
		expect(maxOutput).toBeGreaterThanOrEqual(256);
	});

	it("accounts for images in token estimation", () => {
		const model = makeModel();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image" },
						{ type: "image", data: "base64data", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		};

		const maxOutput = estimateMaxOutputTokens(context, model);

		// Image ~256 tokens, text ~5 tokens, reserve 256 = ~517 input
		// Available = 200000 - 517 = 199483, clamped to 8192
		expect(maxOutput).toBe(8192);
	});

	it("accounts for tool schemas in token estimation", () => {
		const model = makeModel();
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
			tools: [
				{
					name: "read_file",
					description: "Read a file from the filesystem",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "File path" },
						},
						required: ["path"],
					} as any,
				},
			],
		};

		const maxOutput = estimateMaxOutputTokens(context, model);

		// Tool schema ~50 tokens, message ~5 tokens, reserve 256 = ~311 input
		// Available = 200000 - 311 = 199689, clamped to 8192
		expect(maxOutput).toBe(8192);
	});

	it("ensures minimum output tokens even with large input", () => {
		const model = { ...makeModel(), contextWindow: 4000 };
		// Massive input that fills most of the context window
		const hugePrompt = "x".repeat(15000); // ~3750 tokens + 256 reserve = 4006 > 4000
		const context: Context = {
			systemPrompt: hugePrompt,
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const maxOutput = estimateMaxOutputTokens(context, model);

		// Available would be negative, but we enforce MIN_OUTPUT_TOKENS = 256
		expect(maxOutput).toBeGreaterThanOrEqual(256);
	});
});

describe("AI-021: getLastAssistantUsageInfo stale-usage filtering", () => {
	it("returns the last assistant usage when no insertions", () => {
		const messages = [
			{ role: "user", content: "first", timestamp: 1 },
			makeAssistantMessage(makeUsage(100, 50), 2),
			{ role: "user", content: "second", timestamp: 3 },
			makeAssistantMessage(makeUsage(200, 75), 4),
		] as const;

		const result = getLastAssistantUsageInfo(messages);

		expect(result).toBeDefined();
		expect(result?.usage.input).toBe(200);
		expect(result?.usage.output).toBe(75);
		expect(result?.index).toBe(3);
	});

	it("ignores stale assistant usage before inserted prefix (compaction)", () => {
		const messages = [
			{ role: "user", content: "old request", timestamp: 1 },
			makeAssistantMessage(makeUsage(1000, 500), 2), // Stale: reflects old large context
			{ role: "user", content: "[Compaction summary]", timestamp: 3 }, // Inserted prefix
			{ role: "user", content: "new request", timestamp: 4 },
			makeAssistantMessage(makeUsage(200, 50), 5), // Fresh: reflects compacted context
		] as const;

		const result = getLastAssistantUsageInfo(messages);

		expect(result).toBeDefined();
		expect(result?.usage.input).toBe(200);
		expect(result?.usage.output).toBe(50);
		expect(result?.index).toBe(4);
	});

	it("returns renewed usage after stale period", () => {
		const messages = [
			{ role: "user", content: "first", timestamp: 1 },
			makeAssistantMessage(makeUsage(100, 50), 2), // Stale
			{ role: "user", content: "inserted prefix", timestamp: 3 },
			{ role: "user", content: "second", timestamp: 4 },
			makeAssistantMessage(makeUsage(150, 60), 5), // Renewed
			{ role: "user", content: "third", timestamp: 6 },
			makeAssistantMessage(makeUsage(180, 70), 7), // Most recent
		] as const;

		const result = getLastAssistantUsageInfo(messages);

		expect(result).toBeDefined();
		expect(result?.usage.input).toBe(180);
		expect(result?.index).toBe(6);
	});

	it("returns undefined when no assistant messages exist", () => {
		const messages = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
		] as const;

		const result = getLastAssistantUsageInfo(messages);

		expect(result).toBeUndefined();
	});

	it("returns undefined when all assistant messages are stale", () => {
		const messages = [
			{ role: "user", content: "old", timestamp: 1 },
			makeAssistantMessage(makeUsage(100, 50), 2), // Stale
			{ role: "user", content: "inserted", timestamp: 3 },
			{ role: "user", content: "new", timestamp: 4 },
		] as const;

		const result = getLastAssistantUsageInfo(messages);

		expect(result).toBeUndefined();
	});

	it("handles tool-result messages between user and assistant", () => {
		const messages = [
			{ role: "user", content: "use tool", timestamp: 1 },
			makeAssistantMessage(makeUsage(100, 50), 2),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			},
			makeAssistantMessage(makeUsage(120, 60), 4), // Most recent
		] as const;

		const result = getLastAssistantUsageInfo(messages);

		expect(result).toBeDefined();
		expect(result?.usage.input).toBe(120);
		expect(result?.index).toBe(3);
	});
});
