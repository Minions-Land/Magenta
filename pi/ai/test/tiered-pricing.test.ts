import { describe, expect, it } from "vitest";
import { calculateCost, resolveModelCostRates } from "../src/models.ts";
import type { Model, ModelCost, Usage } from "../src/types.ts";

/**
 * AI-023: Volume-based tiered pricing (default/scale) with per-tier rates.
 */

function makeUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeFlatCostModel(cost: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}): Model<"openai-completions"> {
	return {
		id: "flat-model",
		name: "Flat Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeTieredCostModel(): Model<"openai-completions"> {
	return {
		id: "tiered-model",
		name: "Tiered Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			tiers: {
				default: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
				scale: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 },
			},
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

describe("AI-023: tiered pricing", () => {
	describe("resolveModelCostRates", () => {
		it("returns flat rates when cost is not tiered", () => {
			const cost: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
			const rates = resolveModelCostRates(cost, 50000);
			expect(rates).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		});

		it("selects default tier for input volume < 128k", () => {
			const cost: ModelCost = {
				tiers: {
					default: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
					scale: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 },
				},
			};
			const rates = resolveModelCostRates(cost, 127999);
			expect(rates).toEqual({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 });
		});

		it("selects scale tier for input volume ≥ 128k", () => {
			const cost: ModelCost = {
				tiers: {
					default: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
					scale: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 },
				},
			};
			const rates = resolveModelCostRates(cost, 128000);
			expect(rates).toEqual({ input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 });
		});

		it("includes cacheRead and cacheWrite in volume calculation", () => {
			const cost: ModelCost = {
				tiers: {
					default: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
					scale: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 },
				},
			};
			// input=100k, cacheRead=20k, cacheWrite=10k → total 130k ≥ 128k → scale
			const rates = resolveModelCostRates(cost, 100000 + 20000 + 10000);
			expect(rates).toEqual({ input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 });
		});
	});

	describe("calculateCost with flat pricing", () => {
		it("computes cost using flat rates (backward compatible)", () => {
			const model = makeFlatCostModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
			const usage = makeUsage(1000, 500);
			calculateCost(model, usage);

			expect(usage.cost.input).toBeCloseTo(0.003, 6);
			expect(usage.cost.output).toBeCloseTo(0.0075, 6);
			expect(usage.cost.cacheRead).toBe(0);
			expect(usage.cost.cacheWrite).toBe(0);
			expect(usage.cost.total).toBeCloseTo(0.0105, 6);
		});
	});

	describe("calculateCost with tiered pricing", () => {
		it("uses default tier for small input volume", () => {
			const model = makeTieredCostModel();
			const usage = makeUsage(50000, 10000); // 50k input < 128k
			calculateCost(model, usage);

			// default tier: input=2.5, output=10
			expect(usage.cost.input).toBeCloseTo((2.5 / 1000000) * 50000, 6);
			expect(usage.cost.output).toBeCloseTo((10 / 1000000) * 10000, 6);
			expect(usage.cost.total).toBeCloseTo(0.225, 6);
		});

		it("uses scale tier for large input volume", () => {
			const model = makeTieredCostModel();
			const usage = makeUsage(150000, 10000); // 150k input ≥ 128k
			calculateCost(model, usage);

			// scale tier: input=1.25, output=5
			expect(usage.cost.input).toBeCloseTo((1.25 / 1000000) * 150000, 6);
			expect(usage.cost.output).toBeCloseTo((5 / 1000000) * 10000, 6);
			expect(usage.cost.total).toBeCloseTo(0.2375, 6);
		});

		it("includes cacheRead in volume calculation for tier selection", () => {
			const model = makeTieredCostModel();
			const usage = makeUsage(100000, 5000, 30000, 0); // input + cacheRead = 130k ≥ 128k → scale
			calculateCost(model, usage);

			// scale tier: input=1.25, cacheRead=0.125
			expect(usage.cost.input).toBeCloseTo((1.25 / 1000000) * 100000, 6);
			expect(usage.cost.cacheRead).toBeCloseTo((0.125 / 1000000) * 30000, 6);
			expect(usage.cost.total).toBeCloseTo(0.15375, 6);
		});

		it("includes cacheWrite in volume calculation for tier selection", () => {
			const model = makeTieredCostModel();
			const usage = makeUsage(110000, 5000, 0, 20000); // input + cacheWrite = 130k ≥ 128k → scale
			calculateCost(model, usage);

			// scale tier: input=1.25, output=5, cacheWrite=1.5625
			expect(usage.cost.input).toBeCloseTo((1.25 / 1000000) * 110000, 6);
			expect(usage.cost.cacheWrite).toBeCloseTo((1.5625 / 1000000) * 20000, 6);
			expect(usage.cost.total).toBeCloseTo(0.19375, 6);
		});

		it("handles Anthropic 1h cache write pricing at scale tier", () => {
			const model = makeTieredCostModel();
			const usage = makeUsage(150000, 5000, 0, 10000); // 150k input → scale tier
			usage.cacheWrite1h = 4000; // 4k long-write, 6k short-write
			calculateCost(model, usage);

			// scale tier: input=1.25, cacheWrite=1.5625
			// short-write: 6000 * 1.5625/1M, long-write: 4000 * (1.25*2)/1M
			const shortWrite = (1.5625 / 1000000) * 6000;
			const longWrite = ((1.25 * 2) / 1000000) * 4000;
			expect(usage.cost.cacheWrite).toBeCloseTo(shortWrite + longWrite, 6);
		});
	});
});
