import { describe, expect, it } from "vitest";
import { adjustMaxTokensForThinking, clampReasoning } from "../src/api/simple-options.ts";

describe("simple reasoning options", () => {
	it.each(["xhigh", "max"] as const)("clamps %s to high for token-budget providers", (level) => {
		expect(clampReasoning(level)).toBe("high");
		expect(adjustMaxTokensForThinking(4096, 8192, level)).toEqual({
			maxTokens: 8192,
			thinkingBudget: 7168,
		});
	});
});
