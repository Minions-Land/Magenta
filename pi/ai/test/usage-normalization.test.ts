import { describe, expect, it } from "vitest";
import { normalizeBedrockTokenUsage, normalizeGoogleTokenUsage } from "../src/api/usage-normalization.ts";

function componentTotal(usage: ReturnType<typeof normalizeBedrockTokenUsage>): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

describe("provider usage normalization", () => {
	it("splits Bedrock cache tokens out of inclusive inputTokens", () => {
		const usage = normalizeBedrockTokenUsage({
			inputTokens: 100,
			outputTokens: 5,
			totalTokens: 105,
			cacheReadInputTokens: 50,
			cacheWriteInputTokens: 30,
		});

		expect(usage).toMatchObject({ input: 20, output: 5, cacheRead: 50, cacheWrite: 30, totalTokens: 105 });
		expect(componentTotal(usage)).toBe(usage.totalTokens);
	});

	it("preserves Bedrock's one-hour cache-write subset for cost calculation", () => {
		const usage = normalizeBedrockTokenUsage({
			inputTokens: 100,
			outputTokens: 5,
			totalTokens: 105,
			cacheWriteInputTokens: 30,
			cacheDetails: [
				{ ttl: "1h", inputTokens: 10 },
				{ ttl: "5m", inputTokens: 20 },
			],
		});

		expect(usage).toMatchObject({ input: 70, output: 5, cacheWrite: 30, cacheWrite1h: 10, totalTokens: 105 });
	});

	it("includes Google's tool-use prompt tokens in normalized input", () => {
		const usage = normalizeGoogleTokenUsage({
			promptTokenCount: 100,
			cachedContentTokenCount: 40,
			toolUsePromptTokenCount: 20,
			candidatesTokenCount: 10,
			thoughtsTokenCount: 5,
			totalTokenCount: 135,
		});

		expect(usage).toMatchObject({
			input: 80,
			output: 15,
			reasoning: 5,
			cacheRead: 40,
			cacheWrite: 0,
			totalTokens: 135,
		});
		expect(componentTotal(usage)).toBe(usage.totalTokens);
	});

	it("clamps inconsistent cache breakdowns to the inclusive prompt total", () => {
		const usage = normalizeBedrockTokenUsage({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			cacheReadInputTokens: 20,
			cacheWriteInputTokens: 30,
		});

		expect(usage).toMatchObject({ input: 0, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 15 });
		expect(componentTotal(usage)).toBe(usage.totalTokens);
	});

	it("falls back to the normalized component total when a provider omits totalTokens", () => {
		const usage = normalizeGoogleTokenUsage({
			promptTokenCount: 50,
			cachedContentTokenCount: 20,
			toolUsePromptTokenCount: 10,
			candidatesTokenCount: 7,
			thoughtsTokenCount: 3,
		});

		expect(usage).toMatchObject({
			input: 40,
			output: 10,
			reasoning: 3,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 70,
		});
		expect(componentTotal(usage)).toBe(usage.totalTokens);
	});
});
