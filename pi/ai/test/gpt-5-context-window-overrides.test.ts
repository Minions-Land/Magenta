/**
 * Regression tests for GPT-5.x context window overrides.
 *
 * Direct OpenAI:
 * - gpt-5.4/5.5: capped at 272k (observed server limit, not marketing 1.05M)
 * - gpt-5.6/luna/sol/terra: capped at 372k (observed direct API limit ~371.5k)
 *
 * Azure Foundry: restores 1.05M for gpt-5.4/5.5/5.6* (deployed with larger window)
 * OpenRouter: independent upstream metadata (1.05M)
 * openai-codex: inherits OpenAI-direct caps (272k)
 */

import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

describe("GPT-5.4/5.5/5.6 context window provider isolation", () => {
	describe("direct OpenAI caps at observed input limits", () => {
		it("gpt-5.4 = 272K (not 1.05M)", () => {
			const m = getModel("openai", "gpt-5.4");
			expect(m?.contextWindow).toBe(272000);
		});

		it("gpt-5.5 = 272K (not 1.05M)", () => {
			const m = getModel("openai", "gpt-5.5");
			expect(m?.contextWindow).toBe(272000);
		});

		it("gpt-5.6 family = 372K (observed ~371.5k success, not marketing 1.05M)", () => {
			for (const id of ["gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
				const m = getModel("openai", id);
				expect(m?.contextWindow).toBe(372000);
				// The real 128k output cap must survive the contextWindow override.
				expect(m?.maxTokens).toBe(128000);
			}
		});
	});

	describe("Azure Foundry restores 1.05M via AZURE_CONTEXT_WINDOW_OVERRIDES", () => {
		it("gpt-5.4 = 1.05M", () => {
			const m = getModel("azure-openai-responses", "gpt-5.4");
			expect(m?.contextWindow).toBe(1050000);
		});

		it("gpt-5.5 = 1.05M", () => {
			const m = getModel("azure-openai-responses", "gpt-5.5");
			expect(m?.contextWindow).toBe(1050000);
		});

		it("gpt-5.6 family = 1.05M", () => {
			expect(getModel("azure-openai-responses", "gpt-5.6")?.contextWindow).toBe(1050000);
			expect(getModel("azure-openai-responses", "gpt-5.6-luna")?.contextWindow).toBe(1050000);
			expect(getModel("azure-openai-responses", "gpt-5.6-sol")?.contextWindow).toBe(1050000);
			expect(getModel("azure-openai-responses", "gpt-5.6-terra")?.contextWindow).toBe(1050000);
		});
	});

	describe("OpenRouter keeps upstream metadata", () => {
		it("openai/gpt-5.6-sol = 1.05M", () => {
			const m = getModel("openrouter", "openai/gpt-5.6-sol");
			expect(m?.contextWindow).toBe(1050000);
		});
	});

	describe("openai-codex inherits OpenAI-direct caps", () => {
		it("gpt-5.4 = 272K", () => {
			const m = getModel("openai-codex", "gpt-5.4");
			expect(m?.contextWindow).toBe(272000);
		});

		it("gpt-5.5 = 272K", () => {
			const m = getModel("openai-codex", "gpt-5.5");
			expect(m?.contextWindow).toBe(272000);
		});
	});

	describe("adjacent families unchanged", () => {
		it("gpt-5.4-pro = 1.05M (no observed cap)", () => {
			const m = getModel("openai", "gpt-5.4-pro");
			expect(m?.contextWindow).toBe(1050000);
		});

		it("gpt-5.5-pro = 1.05M (no observed cap)", () => {
			const m = getModel("openai", "gpt-5.5-pro");
			expect(m?.contextWindow).toBe(1050000);
		});

		it("gpt-5.4-mini = 400K (unchanged)", () => {
			const m = getModel("openai", "gpt-5.4-mini");
			expect(m?.contextWindow).toBe(400000);
		});
	});
});
