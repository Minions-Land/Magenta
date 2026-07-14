import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

function createSseResponse(): Response {
	const events = [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_current",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-haiku-4-5",
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
					diagnostics: {
						cache_miss_reason: {
							type: "tools_changed",
							cache_missed_input_tokens: 321,
						},
					},
				},
			},
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: {
					input_tokens: 10,
					output_tokens: 1,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function previousAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "prior answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		responseId: "msg_previous",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("Anthropic cache diagnostics", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("opts direct API-key requests into the beta and persists only the redacted miss reason", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		let capturedHeaders: Headers | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request = input instanceof Request ? input : new Request(input, init);
			capturedHeaders = new Headers(request.headers);
			capturedBody = (await request.clone().json()) as Record<string, unknown>;
			return createSseResponse();
		});
		vi.stubGlobal("fetch", fetchMock);

		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			systemPrompt: "stable system",
			messages: [
				{ role: "user", content: "first", timestamp: 0 },
				previousAssistant(),
				{ role: "user", content: "next", timestamp: 2 },
			],
		};
		const result = await streamAnthropic(model, context, {
			apiKey: "sk-ant-api-test",
			env: { PI_CACHE_DIAGNOSTICS: "1" },
			thinkingEnabled: false,
		}).result();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(capturedHeaders?.get("anthropic-beta")?.split(",")).toContain("cache-diagnosis-2026-04-07");
		expect(capturedBody?.diagnostics).toEqual({ previous_message_id: "msg_previous" });
		expect(result.responseId).toBe("msg_current");
		expect(result.diagnostics).toContainEqual({
			type: "anthropic_cache_miss",
			timestamp: expect.any(Number),
			details: { reason: "tools_changed", cacheMissedInputTokens: 321 },
		});
		expect(JSON.stringify(result.diagnostics)).not.toContain("stable system");
		expect(JSON.stringify(result.diagnostics)).not.toContain("prior answer");
	});

	it("does not send cache diagnostics for first-party OAuth requests", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		let capturedHeaders: Headers | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const request = input instanceof Request ? input : new Request(input, init);
				capturedHeaders = new Headers(request.headers);
				capturedBody = (await request.clone().json()) as Record<string, unknown>;
				return createSseResponse();
			}),
		);

		await streamAnthropic(
			getModel("anthropic", "claude-haiku-4-5"),
			{
				systemPrompt: "stable system",
				messages: [{ role: "user", content: "next", timestamp: 2 }],
			},
			{
				apiKey: "sk-ant-oat-test",
				env: { PI_CACHE_DIAGNOSTICS: "1" },
				thinkingEnabled: false,
			},
		).result();

		expect(capturedHeaders?.get("anthropic-beta")?.split(",")).not.toContain("cache-diagnosis-2026-04-07");
		expect(capturedBody?.diagnostics).toBeUndefined();
	});
});
