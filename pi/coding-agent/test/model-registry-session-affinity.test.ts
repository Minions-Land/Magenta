import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.ts";
import { createTestModelRegistry } from "./utilities.ts";

/**
 * CC-042 / AI-032: models.json compat migrated from the removed
 * `sendSessionIdHeader` boolean to `sessionAffinityFormat`
 * (`openai` | `openai-nosession` | `openrouter`). The deprecated boolean is
 * retained as a backward-compat shim until W9 catalog regeneration.
 */
describe("ModelRegistry session affinity format (CC-042)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-affinity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearApiKeyCache();
	});

	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function findModel(registry: ModelRegistry, id: string) {
		return registry.getAll().find((m) => m.id === id);
	}

	test("parses sessionAffinityFormat on a responses-api custom model", async () => {
		writeRawModelsJson({
			"custom-openrouter": {
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "test-key",
				api: "openai-responses",
				models: [
					{
						id: "affinity-model",
						name: "Affinity Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8000,
						compat: { sessionAffinityFormat: "openrouter" },
					},
				],
			},
		});

		const registry = await createTestModelRegistry(authStorage, modelsJsonPath);
		const model = findModel(registry, "affinity-model");
		expect(model).toBeDefined();
		expect((model?.compat as { sessionAffinityFormat?: string })?.sessionAffinityFormat).toBe("openrouter");
	});

	test("parses sessionAffinityFormat on a completions-api custom model", async () => {
		writeRawModelsJson({
			"custom-completions": {
				baseUrl: "https://example.com/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "completions-affinity",
						name: "Completions Affinity",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8000,
						compat: { sessionAffinityFormat: "openai-nosession" },
					},
				],
			},
		});

		const registry = await createTestModelRegistry(authStorage, modelsJsonPath);
		const model = findModel(registry, "completions-affinity");
		expect(model).toBeDefined();
		expect((model?.compat as { sessionAffinityFormat?: string })?.sessionAffinityFormat).toBe("openai-nosession");
	});

	test("still accepts the deprecated sendSessionIdHeader shim", async () => {
		writeRawModelsJson({
			"custom-legacy": {
				baseUrl: "https://example.com/v1",
				apiKey: "test-key",
				api: "openai-responses",
				models: [
					{
						id: "legacy-affinity",
						name: "Legacy Affinity",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8000,
						compat: { sendSessionIdHeader: false },
					},
				],
			},
		});

		const registry = await createTestModelRegistry(authStorage, modelsJsonPath);
		const model = findModel(registry, "legacy-affinity");
		expect(model).toBeDefined();
		expect((model?.compat as { sendSessionIdHeader?: boolean })?.sendSessionIdHeader).toBe(false);
	});

	test("does not crash on an unknown sessionAffinityFormat value (permissive compat union)", async () => {
		writeRawModelsJson({
			"custom-bad": {
				baseUrl: "https://example.com/v1",
				apiKey: "test-key",
				api: "openai-responses",
				models: [
					{
						id: "bad-affinity",
						name: "Bad Affinity",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8000,
						compat: { sessionAffinityFormat: "not-a-format" },
					},
				],
			},
		});

		// ProviderCompatSchema is a permissive TypeBox union (Type.Object allows extra
		// properties), so an unknown affinity value is tolerated, not rejected. This
		// pre-existing looseness is out of CC-042 scope; assert loading does not crash
		// and the raw value is carried through unchanged.
		const registry = await createTestModelRegistry(authStorage, modelsJsonPath);
		const model = findModel(registry, "bad-affinity");
		expect(model).toBeDefined();
		expect((model?.compat as { sessionAffinityFormat?: string })?.sessionAffinityFormat).toBe("not-a-format");
	});
});
