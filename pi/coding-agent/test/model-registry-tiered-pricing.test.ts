import type { Model, ModelCost, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { applyModelOverride, clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.ts";

/**
 * CC-037: coding-agent consumes AI-023 volume-based tiered pricing through
 * models.json model definitions and modelOverrides. Verifies the registry
 * parses/serializes tiered cost, merges overrides correctly, and that the
 * resulting model selects the right tier at the request-wide input boundary.
 */

function makeUsage(input: number): Usage {
	return {
		input,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const TIERED_COST: ModelCost = {
	tiers: {
		default: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
		scale: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
	},
};

describe("ModelRegistry tiered pricing (CC-037)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-tiered-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string): Model<"anthropic-messages">[] {
		return registry.getAll().filter((m) => m.provider === provider) as Model<"anthropic-messages">[];
	}

	test("parses a custom model with tiered cost from models.json", () => {
		writeRawModelsJson({
			"custom-tiered": {
				baseUrl: "https://example.com",
				apiKey: "test-key",
				api: "anthropic-messages",
				models: [
					{
						id: "tiered-model",
						name: "Tiered Model",
						reasoning: false,
						input: ["text"],
						cost: TIERED_COST,
						contextWindow: 400000,
						maxTokens: 8000,
					},
				],
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = getModelsForProvider(registry, "custom-tiered").find((m) => m.id === "tiered-model");

		expect(model).toBeDefined();
		expect("tiers" in model!.cost).toBe(true);
		if ("tiers" in model!.cost) {
			expect(model!.cost.tiers.default.input).toBe(1);
			expect(model!.cost.tiers.scale.input).toBe(2);
		}
	});

	test("selects the correct tier at the 128k request-wide input boundary", () => {
		writeRawModelsJson({
			"custom-tiered": {
				baseUrl: "https://example.com",
				apiKey: "test-key",
				api: "anthropic-messages",
				models: [
					{
						id: "tiered-model",
						name: "Tiered Model",
						reasoning: false,
						input: ["text"],
						cost: TIERED_COST,
						contextWindow: 400000,
						maxTokens: 8000,
					},
				],
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = getModelsForProvider(registry, "custom-tiered").find((m) => m.id === "tiered-model")!;

		// Below the 128k threshold -> default tier (input rate 1/M)
		const below = calculateCost(model, makeUsage(127_999));
		// At/above the 128k threshold -> scale tier (input rate 2/M)
		const atBoundary = calculateCost(model, makeUsage(128_000));

		expect(below.input).toBeCloseTo((127_999 / 1_000_000) * 1, 6);
		expect(atBoundary.input).toBeCloseTo((128_000 / 1_000_000) * 2, 6);
		// Scale tier must be strictly pricier per token
		expect(atBoundary.input / 128_000).toBeGreaterThan(below.input / 127_999);
	});

	test("applyModelOverride: tiered override replaces a flat base cost entirely", () => {
		const flatBase: Model<"anthropic-messages"> = {
			id: "flat-model",
			name: "Flat Model",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 },
			contextWindow: 200000,
			maxTokens: 8000,
		};

		const merged = applyModelOverride(flatBase, { cost: TIERED_COST });

		expect("tiers" in merged.cost).toBe(true);
		if ("tiers" in merged.cost) {
			expect(merged.cost.tiers.default.input).toBe(1);
			expect(merged.cost.tiers.scale.input).toBe(2);
		}
	});

	test("applyModelOverride: partial flat override applied to tiered base collapses to flat with default-tier fallback", () => {
		const tieredBase: Model<"anthropic-messages"> = {
			id: "tiered-model",
			name: "Tiered Model",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			reasoning: false,
			input: ["text"],
			cost: TIERED_COST,
			contextWindow: 400000,
			maxTokens: 8000,
		};

		const merged = applyModelOverride(tieredBase, { cost: { input: 99 } });

		// A partial flat override collapses the tiered base to a flat cost based on default tier.
		expect("tiers" in merged.cost).toBe(false);
		if (!("tiers" in merged.cost)) {
			expect(merged.cost.input).toBe(99);
			// Untouched fields fall back to the default tier values
			expect(merged.cost.output).toBe(TIERED_COST.tiers.default.output);
			expect(merged.cost.cacheRead).toBe(TIERED_COST.tiers.default.cacheRead);
		}
	});

	test("modelOverrides with tiered cost replaces a built-in flat model through config", () => {
		writeRawModelsJson({
			openrouter: {
				modelOverrides: {
					"anthropic/claude-sonnet-4": {
						cost: TIERED_COST,
					},
				},
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const sonnet = registry.getAll().find((m) => m.id === "anthropic/claude-sonnet-4");

		expect(sonnet).toBeDefined();
		expect("tiers" in sonnet!.cost).toBe(true);
		if ("tiers" in sonnet!.cost) {
			expect(sonnet!.cost.tiers.default.input).toBe(1);
			expect(sonnet!.cost.tiers.scale.input).toBe(2);
		}
	});

	test("rejects malformed tiered cost missing a required tier", () => {
		writeRawModelsJson({
			"custom-bad": {
				baseUrl: "https://example.com",
				apiKey: "test-key",
				api: "anthropic-messages",
				models: [
					{
						id: "bad-model",
						name: "Bad Model",
						reasoning: false,
						input: ["text"],
						cost: { tiers: { default: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } } },
						contextWindow: 400000,
						maxTokens: 8000,
					},
				],
			},
		});

		// Invalid config must not crash the registry; the malformed provider is dropped/ignored.
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = registry.getAll().find((m) => m.id === "bad-model");
		expect(model).toBeUndefined();
	});
});
