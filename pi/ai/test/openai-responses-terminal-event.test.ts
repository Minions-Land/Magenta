import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

vi.mock("openai", () => {
	async function* createMockResponsesStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_wrapper_early_eof" },
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "reasoning", id: "rs_wrapper_early_eof", summary: [] },
		} as ResponseStreamEvent;
		yield {
			type: "response.reasoning_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			item_id: "rs_wrapper_early_eof",
			delta: "partial reasoning before the wrapper stream ends",
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createMockResponsesStream();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
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

async function* createEarlyEofEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		sequence_number: 0,
		response: { id: "resp_early_eof" },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 0,
		item: { type: "reasoning", id: "rs_early_eof", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		sequence_number: 2,
		output_index: 0,
		content_index: 0,
		item_id: "rs_early_eof",
		delta: "partial reasoning before the stream ends",
	} as ResponseStreamEvent;
}

async function* createCompletedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_completed",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createIncompleteEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.incomplete",
		sequence_number: 0,
		response: {
			id: "resp_incomplete",
			status: "incomplete",
			usage: {
				input_tokens: 30,
				output_tokens: 12,
				total_tokens: 42,
				input_tokens_details: { cached_tokens: 5, cache_write_tokens: 0 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createCacheWriteEvents(overreported = false): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_cache_write",
			status: "completed",
			usage: overreported
				? {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
					}
				: {
						input_tokens: 100,
						output_tokens: 5,
						total_tokens: 105,
						input_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
					},
		},
	} as ResponseStreamEvent;
}

async function* createFailedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.failed",
		sequence_number: 0,
		response: {
			id: "resp_failed",
			status: "failed",
			error: { code: "server_error", message: "boom" },
		},
	} as ResponseStreamEvent;
}

describe("OpenAI Responses terminal event handling", () => {
	it("rejects streams that end before a terminal response event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createEarlyEofEvents(), output, stream, model)).rejects.toThrow(
			"OpenAI Responses stream ended before a terminal response event",
		);
	});

	it("emits an error final result when the wrapper stream ends before a terminal response event", async () => {
		const model = createModel();
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
			tools: [],
		};
		const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];

		for await (const event of stream) {
			events.push(event);
		}

		const result = await stream.result();
		const lastEvent = events.at(-1);
		expect(lastEvent?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI Responses stream ended before a terminal response event");
	});

	it("finalizes completed terminal events as stop", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCompletedEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_completed");
		expect(output.stopReason).toBe("stop");
		expect(output.usage).toMatchObject({
			input: 18,
			output: 7,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 27,
		});
	});

	it("finalizes incomplete terminal events as length stops", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createIncompleteEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.usage).toMatchObject({
			input: 25,
			output: 12,
			cacheRead: 5,
			cacheWrite: 0,
			totalTokens: 42,
		});
	});

	it("normalizes GPT-5.6 cache reads and writes without double-counting input", async () => {
		const model: Model<"openai-responses"> = {
			...createModel(),
			id: "gpt-5.6",
			name: "GPT-5.6",
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		};
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCacheWriteEvents(), output, stream, model);

		expect(output.usage).toMatchObject({
			input: 20,
			output: 5,
			cacheRead: 50,
			cacheWrite: 30,
			totalTokens: 105,
		});
		expect(output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite).toBe(105);
		expect(output.usage.cost.input).toBeCloseTo(0.0001, 12);
		expect(output.usage.cost.output).toBeCloseTo(0.00015, 12);
		expect(output.usage.cost.cacheRead).toBeCloseTo(0.000025, 12);
		expect(output.usage.cost.cacheWrite).toBeCloseTo(0.0001875, 12);
		expect(output.usage.cost.total).toBeCloseTo(0.0004625, 12);
	});

	it("clamps inconsistent cache components to the reported prompt-token total", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCacheWriteEvents(true), output, stream, model);

		expect(output.usage).toMatchObject({ input: 0, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 15 });
	});

	it("rejects failed terminal events with the provider error", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createFailedEvents(), output, stream, model)).rejects.toThrow(
			"server_error: boom",
		);
	});
});
