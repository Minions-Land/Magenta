import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model, StreamOptions } from "../src/types.ts";

class PayloadCaptured extends Error {}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolContext(): Context {
	return {
		systemPrompt: "stable system",
		messages: [
			{ role: "user", content: "run a tool", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1|fc_1", name: "example", arguments: {} }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.6",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "example",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

async function capturePayload(
	model: Model<"openai-responses">,
	context: Context,
	options: StreamOptions,
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	await streamOpenAIResponses(model, context, {
		...options,
		onPayload: (payload) => {
			captured = payload as Record<string, unknown>;
			throw new PayloadCaptured();
		},
	}).result();
	if (!captured) throw new Error("Provider payload was not captured");
	return captured;
}

function breakpointCount(payload: unknown): number {
	return (JSON.stringify(payload).match(/"prompt_cache_breakpoint"/g) ?? []).length;
}

describe("OpenAI Responses explicit prompt cache breakpoints", () => {
	it("adds gated implicit-mode options and cacheable tool-output boundaries for GPT-5.6", async () => {
		const payload = await capturePayload(getModel("openai", "gpt-5.6"), toolContext(), {
			apiKey: "sk-test",
			env: { PI_OPENAI_PROMPT_CACHE_MODE: "implicit" },
		});

		expect(payload.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(breakpointCount(payload)).toBe(3);
		const input = payload.input as Array<Record<string, unknown>>;
		const toolOutput = input.find((item) => item.type === "function_call_output");
		expect(toolOutput?.output).toEqual([
			{ type: "input_text", text: "tool output", prompt_cache_breakpoint: { mode: "explicit" } },
		]);
	});

	it("limits explicit mode to four boundaries while retaining the stable system boundary", async () => {
		const context: Context = {
			systemPrompt: "stable system",
			messages: Array.from({ length: 6 }, (_, index) => ({
				role: "user" as const,
				content: `message ${index}`,
				timestamp: index,
			})),
		};
		const payload = await capturePayload(getModel("openai", "gpt-5.6"), context, {
			apiKey: "sk-test",
			env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" },
		});

		expect(payload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		expect(breakpointCount(payload)).toBe(4);
		const firstInput = (payload.input as Array<Record<string, unknown>>)[0];
		expect(firstInput.content).toEqual([
			{ type: "input_text", text: "stable system", prompt_cache_breakpoint: { mode: "explicit" } },
		]);
	});

	it.each([
		{
			name: "the experiment is disabled",
			model: getModel("openai", "gpt-5.6"),
			options: { apiKey: "sk-test" },
		},
		{
			name: "the model predates GPT-5.6",
			model: getModel("openai", "gpt-5.5"),
			options: { apiKey: "sk-test", env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" } },
		},
		{
			name: "the endpoint is a proxy",
			model: { ...getModel("openai", "gpt-5.6"), baseUrl: "https://proxy.example/v1" },
			options: { apiKey: "sk-test", env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" } },
		},
		{
			name: "the provider is not OpenAI",
			model: { ...getModel("openai", "gpt-5.6"), provider: "github-copilot" },
			options: { apiKey: "sk-test", env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" } },
		},
		{
			name: "authentication is header-owned",
			model: getModel("openai", "gpt-5.6"),
			options: {
				headers: { authorization: "Bearer test" },
				env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" },
			},
		},
		{
			name: "authentication is supplied by model headers",
			model: {
				...getModel("openai", "gpt-5.6"),
				headers: { authorization: "Bearer model-owned" },
			},
			options: { env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" } },
		},
		{
			name: "authentication uses an OAuth-like bearer token",
			model: getModel("openai", "gpt-5.6"),
			options: {
				apiKey: "eyJ-oauth-token",
				env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" },
			},
		},
		{
			name: "cache retention is disabled",
			model: getModel("openai", "gpt-5.6"),
			options: {
				apiKey: "sk-test",
				cacheRetention: "none" as const,
				env: { PI_OPENAI_PROMPT_CACHE_MODE: "explicit" },
			},
		},
	])("omits new fields when $name", async ({ model, options }) => {
		const payload = await capturePayload(model as Model<"openai-responses">, toolContext(), options);
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(breakpointCount(payload)).toBe(0);
	});
});
