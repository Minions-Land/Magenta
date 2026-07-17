import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import type { Model } from "../src/types.ts";

/**
 * AI-022 + AI-024: Separate max from xhigh in metadata-driven support.
 * Uses synthetic fixtures since catalogs aren't regenerated.
 */

describe("AI-022/AI-024: max/xhigh metadata-driven support", () => {
	describe("xhigh requires explicit thinkingLevelMap entry", () => {
		it("exposes xhigh when explicitly mapped", () => {
			const model: Model<"anthropic-messages"> = {
				id: "test-xhigh",
				name: "Test xhigh",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				},
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8192,
			};

			const levels = getSupportedThinkingLevels(model);
			expect(levels).toContain("xhigh");
			expect(levels).not.toContain("max");
			expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
		});

		it("does NOT expose xhigh when missing from map and model lacks native support", () => {
			const model: Model<"openai-completions"> = {
				id: "gpt-4o-no-xhigh",
				name: "GPT-4o (no xhigh)",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				thinkingLevelMap: { minimal: "low" },
				input: ["text"],
				cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 128000,
				maxTokens: 16384,
			};

			const levels = getSupportedThinkingLevels(model);
			expect(levels).not.toContain("xhigh");
			expect(levels).not.toContain("max");
			// Requested xhigh clamps down to high.
			expect(clampThinkingLevel(model, "xhigh")).toBe("high");
		});
	});

	describe("max requires explicit thinkingLevelMap entry", () => {
		it("exposes max when explicitly mapped", () => {
			const model: Model<"anthropic-messages"> = {
				id: "claude-opus-4-8-max",
				name: "Claude Opus 4.8",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				compat: { forceAdaptiveThinking: true },
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				},
				input: ["text"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 200000,
				maxTokens: 16384,
			};

			const levels = getSupportedThinkingLevels(model);
			expect(levels).toContain("xhigh");
			expect(levels).toContain("max");
			expect(clampThinkingLevel(model, "max")).toBe("max");
		});

		it("does NOT expose max when missing from map", () => {
			const model: Model<"openai-completions"> = {
				id: "gpt-5.3-no-max",
				name: "GPT-5.3",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				thinkingLevelMap: {
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				},
				input: ["text"],
				cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
				contextWindow: 128000,
				maxTokens: 8192,
			};

			const levels = getSupportedThinkingLevels(model);
			expect(levels).toContain("xhigh");
			expect(levels).not.toContain("max");
			// Requested max clamps down to xhigh.
			expect(clampThinkingLevel(model, "max")).toBe("xhigh");
		});
	});

	describe("legacy Claude models must NOT expose max", () => {
		it("Claude Sonnet 3.5 (2024-10-22) has no max even if forceAdaptiveThinking", () => {
			const model: Model<"anthropic-messages"> = {
				id: "claude-3-5-sonnet-20241022",
				name: "Claude 3.5 Sonnet",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				// Legacy adaptive models get xhigh via fallback but not max.
				compat: { forceAdaptiveThinking: true },
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					// No xhigh, no max
				},
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8192,
			};

			const levels = getSupportedThinkingLevels(model);
			// forceAdaptiveThinking provides xhigh fallback.
			expect(levels).toContain("xhigh");
			// max always requires explicit map entry.
			expect(levels).not.toContain("max");
			expect(clampThinkingLevel(model, "max")).toBe("xhigh");
		});

		it("Claude Opus 3.7 with no map does not expose xhigh or max", () => {
			const model: Model<"anthropic-messages"> = {
				id: "claude-opus-3-7",
				name: "Claude Opus 3.7",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				// No thinkingLevelMap at all.
				input: ["text"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 200000,
				maxTokens: 4096,
			};

			const levels = getSupportedThinkingLevels(model);
			expect(levels).not.toContain("xhigh");
			expect(levels).not.toContain("max");
			expect(clampThinkingLevel(model, "max")).toBe("high");
			expect(clampThinkingLevel(model, "xhigh")).toBe("high");
		});
	});

	describe("independent xhigh and max support", () => {
		it("model can have xhigh without max", () => {
			const model: Model<"anthropic-messages"> = {
				id: "claude-sonnet-4-5-xhigh-only",
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					// No max
				},
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8192,
			};

			const levels = getSupportedThinkingLevels(model);
			expect(levels).toContain("xhigh");
			expect(levels).not.toContain("max");
		});

		it("model can have max without xhigh map entry (adaptive gets xhigh via fallback)", () => {
			const model: Model<"anthropic-messages"> = {
				id: "claude-adaptive-max-only",
				name: "Claude Adaptive Max",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				compat: { forceAdaptiveThinking: true },
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					// No xhigh map, but forceAdaptiveThinking provides fallback.
					max: "max",
				},
				input: ["text"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 200000,
				maxTokens: 16384,
			};

			const levels = getSupportedThinkingLevels(model);
			// forceAdaptiveThinking provides xhigh fallback even without map entry.
			expect(levels).toContain("xhigh");
			expect(levels).toContain("max");
		});
	});
});
