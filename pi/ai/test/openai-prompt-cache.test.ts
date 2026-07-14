import { describe, expect, it } from "vitest";
import { clampOpenAIPromptCacheKey, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "../src/api/openai-prompt-cache.ts";

describe("OpenAI prompt cache keys", () => {
	it("keeps keys within the provider limit without changing short keys", () => {
		expect(clampOpenAIPromptCacheKey(undefined)).toBeUndefined();
		expect(clampOpenAIPromptCacheKey("session-123")).toBe("session-123");
		expect(clampOpenAIPromptCacheKey("x".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH))).toBe(
			"x".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH),
		);
	});

	it("adds a digest so long keys with the same prefix remain distinct", () => {
		const sharedPrefix = "x".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH + 20);
		const first = clampOpenAIPromptCacheKey(`${sharedPrefix}-first`)!;
		const second = clampOpenAIPromptCacheKey(`${sharedPrefix}-second`)!;

		expect(Array.from(first)).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
		expect(first).toMatch(/^x{31}-[a-f0-9]{32}$/);
		expect(first).not.toBe(second);
		expect(clampOpenAIPromptCacheKey(`${sharedPrefix}-first`)).toBe(first);
	});

	it("counts Unicode code points when preserving the readable prefix", () => {
		const key = `${"\u{1f642}".repeat(70)}-session`;
		const clamped = clampOpenAIPromptCacheKey(key)!;

		expect(Array.from(clamped)).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
		expect(clamped.startsWith("\u{1f642}".repeat(31))).toBe(true);
	});
});
