import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai-responses",
		baseUrl: "https://example.invalid",
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

// Two output items opened before either is done, with interleaved deltas.
// The single-cursor implementation dropped deltas for whichever item was not
// "current"; slot-keyed tracking must route each delta to the right block.
async function* interleavedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 0,
		item: { type: "reasoning", id: "rs_0", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 1,
		sequence_number: 1,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "in_progress",
			content: [],
		},
	} as ResponseStreamEvent;
	// Interleave: reasoning delta, then text delta, then reasoning delta again.
	yield {
		type: "response.reasoning_text.delta",
		output_index: 0,
		sequence_number: 2,
		delta: "think-a",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		output_index: 1,
		sequence_number: 3,
		delta: "answer-a",
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		output_index: 0,
		sequence_number: 4,
		delta: "think-b",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		output_index: 1,
		sequence_number: 5,
		delta: "answer-b",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 6,
		item: {
			type: "reasoning",
			id: "rs_0",
			summary: [],
			content: [{ type: "reasoning_text", text: "think-ab" }],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 1,
		sequence_number: 7,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "answer-ab", annotations: [] }],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 8,
		response: { id: "resp_test", status: "completed", output: [] },
	} as ResponseStreamEvent;
}

describe("OpenAI Responses out-of-order items", () => {
	it("routes interleaved deltas to the correct block by output_index", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(interleavedEvents(), output, new AssistantMessageEventStream(), model);

		const thinking = output.content.find((b) => b.type === "thinking");
		const text = output.content.find((b) => b.type === "text");

		expect(thinking).toBeDefined();
		expect(text).toBeDefined();
		if (thinking?.type !== "thinking" || text?.type !== "text") {
			throw new Error("expected both a thinking and a text block");
		}
		// output_item.done overrides streamed thinking with content text.
		expect(thinking.thinking).toBe("think-ab");
		// Streamed text deltas both landed on the message block despite interleaving.
		expect(text.text).toBe("answer-ab");
	});
});
