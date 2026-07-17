import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { calculateCost } from "../src/models.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

/**
 * AI-003: reasoning tokens are a subset of output tokens. Verify they are
 * exposed for telemetry but never added to totals or cost.
 */

function makeModel(provider: string, api: string): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: api as any,
		provider,
		baseUrl: "https://api.example.com",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function makeUsage(
	input: number,
	output: number,
	reasoning: number | undefined,
	cacheRead = 0,
	cacheWrite = 0,
): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoning !== undefined ? { reasoning } : {}),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AI-003: reasoning tokens subset", () => {
	describe("reasoning field presence", () => {
		it("undefined when provider does not report reasoning tokens", () => {
			const usage = makeUsage(1000, 500, undefined);
			const model = makeModel("anthropic", "anthropic-messages");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(undefined);
			expect(usage.totalTokens).toBe(1500);
			expect(usage.cost.total).toBeCloseTo(0.0105, 6);
		});

		it("zero when provider reports zero reasoning tokens", () => {
			const usage = makeUsage(1000, 500, 0);
			const model = makeModel("openai", "openai-responses");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(0);
			expect(usage.totalTokens).toBe(1500);
			expect(usage.cost.total).toBeCloseTo(0.0105, 6);
		});

		it("nonzero when provider reports reasoning tokens", () => {
			const usage = makeUsage(1000, 500, 200);
			const model = makeModel("openai", "openai-completions");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(200);
			expect(usage.output).toBe(500);
			expect(usage.totalTokens).toBe(1500);
		});
	});

	describe("reasoning is a subset of output", () => {
		it("reasoning tokens are not added to totalTokens", () => {
			const usage = makeUsage(1000, 500, 200);
			const model = makeModel("openai", "openai-completions");
			calculateCost(model, usage);
			// totalTokens = input + output + cacheRead + cacheWrite, not + reasoning
			expect(usage.totalTokens).toBe(1500);
			expect(usage.totalTokens).toBe(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
		});

		it("reasoning tokens are not added to cost.output", () => {
			const usage = makeUsage(1000, 500, 200);
			const model = makeModel("openai", "openai-responses");
			calculateCost(model, usage);
			// Cost is based on output=500, not output + reasoning
			expect(usage.cost.output).toBeCloseTo((15 / 1000000) * 500, 6);
			expect(usage.cost.output).not.toBeCloseTo((15 / 1000000) * 700, 6);
		});

		it("reasoning tokens are not added to cost.total", () => {
			const usage = makeUsage(1000, 500, 300);
			const model = makeModel("openai", "openai-codex-responses");
			calculateCost(model, usage);
			const expected = (3 * 1000 + 15 * 500) / 1000000;
			expect(usage.cost.total).toBeCloseTo(expected, 6);
		});

		it("reasoning = output tokens does not double-count cost", () => {
			const usage = makeUsage(1000, 500, 500);
			const model = makeModel("google", "google-generative-ai");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(500);
			expect(usage.output).toBe(500);
			// Cost is still based on output=500
			expect(usage.cost.output).toBeCloseTo((15 / 1000000) * 500, 6);
			expect(usage.cost.total).toBeCloseTo((3 * 1000 + 15 * 500) / 1000000, 6);
		});
	});

	describe("reasoning with cache does not double-count", () => {
		it("reasoning + cache reads", () => {
			const usage = makeUsage(1000, 500, 300, 2000, 0);
			const model = makeModel("openai", "openai-codex-responses");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(300);
			expect(usage.totalTokens).toBe(3500);
			const expected = (3 * 1000 + 15 * 500 + 0.3 * 2000) / 1000000;
			expect(usage.cost.total).toBeCloseTo(expected, 6);
		});

		it("reasoning + cache writes", () => {
			const usage = makeUsage(1000, 500, 400, 0, 5000);
			const model = makeModel("azure-openai-responses", "azure-openai-responses");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(400);
			expect(usage.totalTokens).toBe(6500);
			const expected = (3 * 1000 + 15 * 500 + 3.75 * 5000) / 1000000;
			expect(usage.cost.total).toBeCloseTo(expected, 6);
		});

		it("reasoning + 1h cache write (Anthropic)", () => {
			const usage: Usage = {
				input: 1000,
				output: 500,
				reasoning: 200,
				cacheRead: 0,
				cacheWrite: 3000,
				cacheWrite1h: 1000,
				totalTokens: 4500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const model = makeModel("anthropic", "anthropic-messages");
			calculateCost(model, usage);
			expect(usage.reasoning).toBe(200);
			// Anthropic charges 2x base input for 1h writes; 1000 1h + 2000 short.
			// Short writes use cost.cacheWrite; 1h writes use 2x cost.input.
			const expectedCacheWrite = (3.75 * 2000 + 3 * 2 * 1000) / 1000000;
			expect(usage.cost.cacheWrite).toBeCloseTo(expectedCacheWrite, 6);
			const expectedTotal = (3 * 1000 + 15 * 500) / 1000000 + expectedCacheWrite;
			expect(usage.cost.total).toBeCloseTo(expectedTotal, 6);
		});
	});
});

/**
 * Per-provider parser tests: verify the parsers extract reasoning tokens
 * from provider-specific fields and populate usage.reasoning correctly.
 */

function makeResponsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-test",
		name: "GPT-5 Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function makeResponsesOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AI-003: per-provider parsers", () => {
	describe("OpenAI Responses (Responses/Codex/Azure)", () => {
		async function* makeResponsesEvents(reasoningTokens: number | undefined): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.completed",
				sequence_number: 0,
				response: {
					id: "resp_test",
					status: "completed",
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						total_tokens: 1500,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens_details:
							reasoningTokens === undefined ? undefined : { reasoning_tokens: reasoningTokens },
					},
				},
			} as ResponseStreamEvent;
		}

		it("undefined when provider does not report reasoning_tokens", async () => {
			const model = makeResponsesModel();
			const output = makeResponsesOutput(model);
			const stream = new AssistantMessageEventStream();
			await processResponsesStream(makeResponsesEvents(undefined), output, stream, model);
			expect(output.usage.reasoning).toBe(undefined);
			expect(output.usage.output).toBe(500);
			expect(output.usage.totalTokens).toBe(1500);
		});

		it("zero when provider reports zero reasoning_tokens", async () => {
			const model = makeResponsesModel();
			const output = makeResponsesOutput(model);
			const stream = new AssistantMessageEventStream();
			await processResponsesStream(makeResponsesEvents(0), output, stream, model);
			expect(output.usage.reasoning).toBe(undefined); // 0 is filtered out by the conditional
			expect(output.usage.output).toBe(500);
		});

		it("nonzero when provider reports reasoning_tokens", async () => {
			const model = makeResponsesModel();
			const output = makeResponsesOutput(model);
			const stream = new AssistantMessageEventStream();
			await processResponsesStream(makeResponsesEvents(200), output, stream, model);
			expect(output.usage.reasoning).toBe(200);
			expect(output.usage.output).toBe(500);
			expect(output.usage.totalTokens).toBe(1500);
		});
	});

	describe("Anthropic Messages", () => {
		function createSseResponse(events: Array<{ event: string; data: string }>): Response {
			const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}

		function createFakeAnthropicClient(response: Response): Anthropic {
			return {
				messages: {
					create: () => ({
						asResponse: async () => response,
					}),
				},
			} as unknown as Anthropic;
		}

		function anthropicEvents(thinkingTokens: number | undefined): Array<{ event: string; data: string }> {
			const outputTokensDetails = thinkingTokens === undefined ? undefined : { thinking_tokens: thinkingTokens };
			return [
				{
					event: "message_start",
					data: JSON.stringify({
						type: "message_start",
						message: {
							id: "msg_test",
							usage: {
								input_tokens: 1000,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					}),
				},
				{
					event: "content_block_start",
					data: JSON.stringify({
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					}),
				},
				{
					event: "content_block_delta",
					data: JSON.stringify({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Hello" },
					}),
				},
				{
					event: "content_block_stop",
					data: JSON.stringify({ type: "content_block_stop", index: 0 }),
				},
				{
					event: "message_delta",
					data: JSON.stringify({
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
							...(outputTokensDetails ? { output_tokens_details: outputTokensDetails } : {}),
						},
					}),
				},
				{
					event: "message_stop",
					data: JSON.stringify({ type: "message_stop" }),
				},
			];
		}

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		it("undefined when Anthropic omits output_tokens_details.thinking_tokens", async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			const response = createSseResponse(anthropicEvents(undefined));
			const result = await streamAnthropic(model, context, {
				client: createFakeAnthropicClient(response),
			}).result();
			expect(result.usage.reasoning).toBe(undefined);
			expect(result.usage.output).toBe(500);
			expect(result.usage.totalTokens).toBe(1500);
		});

		it("undefined when Anthropic reports zero thinking_tokens", async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			const response = createSseResponse(anthropicEvents(0));
			const result = await streamAnthropic(model, context, {
				client: createFakeAnthropicClient(response),
			}).result();
			expect(result.usage.reasoning).toBe(undefined);
			expect(result.usage.output).toBe(500);
		});

		it("nonzero when Anthropic reports thinking_tokens", async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			const response = createSseResponse(anthropicEvents(180));
			const result = await streamAnthropic(model, context, {
				client: createFakeAnthropicClient(response),
			}).result();
			expect(result.usage.reasoning).toBe(180);
			expect(result.usage.output).toBe(500);
			expect(result.usage.totalTokens).toBe(1500);
		});
	});
});
