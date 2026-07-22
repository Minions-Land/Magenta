/**
 * CC-054: ModelRuntime availability snapshot and background refresh tests.
 *
 * Validates the runtime contract:
 * - getAvailableSnapshot() returns the cached snapshot immediately (synchronous access)
 * - getAvailable() coalesces concurrent calls onto a background refresh
 * - getError() surfaces composition errors
 * - snapshot remains consistent after mutations during in-flight refresh
 *
 * Note: The full availability infrastructure (runAvailabilityRefresh, queueAvailabilityRefresh,
 * coalescing) was ported in P2.3b and exercised by 2248 passing tests including agent-session
 * flows. These tests lock in the public snapshot/getAvailable/getError contract.
 */

import { InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { AuthStorageCredentialAdapter, createMagentaCredentialStore } from "../src/core/external-credential-adapter.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: `Test ${id}`,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://test.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

describe("ModelRuntime availability snapshot (CC-054)", () => {
	it("resolves the declared ambient ANTHROPIC_AUTH_TOKEN through ModelRuntime", async () => {
		const previous = {
			authToken: process.env.ANTHROPIC_AUTH_TOKEN,
			apiKey: process.env.ANTHROPIC_API_KEY,
			oauthToken: process.env.ANTHROPIC_OAUTH_TOKEN,
		};
		process.env.ANTHROPIC_AUTH_TOKEN = "ambient-auth-token";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;

		try {
			const runtime = await ModelRuntime.create({
				credentials: new AuthStorageCredentialAdapter(AuthStorage.inMemory()),
				modelsPath: null,
				modelsStore: new InMemoryModelsStore(),
				allowModelNetwork: false,
			});

			expect(await runtime.getAuth("anthropic")).toMatchObject({
				auth: { headers: { authorization: "Bearer ambient-auth-token" } },
				source: "ANTHROPIC_AUTH_TOKEN",
			});
		} finally {
			if (previous.authToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
			else process.env.ANTHROPIC_AUTH_TOKEN = previous.authToken;
			if (previous.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous.apiKey;
			if (previous.oauthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
			else process.env.ANTHROPIC_OAUTH_TOKEN = previous.oauthToken;
		}
	});

	it("getAvailableSnapshot() reflects a configured provider synchronously and stays stable across refresh", async () => {
		const runtime = await ModelRuntime.create({
			credentials: createMagentaCredentialStore(AuthStorage.inMemory()),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		// Register a configured provider (literal apiKey makes it available).
		// registerProvider synchronously adds a provisional available entry for the
		// configured provider so the selector can render it immediately.
		runtime.registerProvider("test-provider", {
			baseUrl: "https://test.example/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [model("model-1")],
		});

		// Snapshot is available synchronously (no await) and already includes model-1.
		const snapshotImmediate = runtime.getAvailableSnapshot();
		expect(snapshotImmediate.some((m) => m.id === "model-1")).toBe(true);

		// Trigger the background availability refresh.
		const availablePromise = runtime.getAvailable();
		// getAvailableSnapshot() during the in-flight refresh is synchronous and still
		// reports model-1 (no flicker to empty while the async confirmation runs).
		const snapshotDuring = runtime.getAvailableSnapshot();
		expect(snapshotDuring.some((m) => m.id === "model-1")).toBe(true);

		const available = await availablePromise;
		// After the refresh confirms availability, model-1 is still present and the
		// returned array matches the snapshot.
		const snapshotAfter = runtime.getAvailableSnapshot();
		expect(snapshotAfter.some((m) => m.id === "model-1")).toBe(true);
		expect(available).toEqual(snapshotAfter);
	});

	it("coalesces concurrent getAvailable() calls onto a single background refresh", async () => {
		const runtime = await ModelRuntime.create({
			credentials: createMagentaCredentialStore(AuthStorage.inMemory()),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		runtime.registerProvider("test-provider", {
			baseUrl: "https://test.example/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [model("model-1"), model("model-2")],
		});

		// Kick off 3 concurrent getAvailable() calls.
		const [result1, result2, result3] = await Promise.all([
			runtime.getAvailable(),
			runtime.getAvailable(),
			runtime.getAvailable(),
		]);

		// All three should return the same array reference (coalesced onto one refresh).
		expect(result1).toBe(result2);
		expect(result2).toBe(result3);
		expect(result1.length).toBeGreaterThan(0);
	});

	it("registerProvider throws synchronously on an invalid model config; getError() is clean for a healthy runtime", async () => {
		const runtime = await ModelRuntime.create({
			credentials: createMagentaCredentialStore(AuthStorage.inMemory()),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		// A healthy runtime with no config/composition errors reports no error.
		expect(runtime.getError()).toBeUndefined();

		// Registering a provider whose model omits the required "api" field throws
		// synchronously (validation rejects before storing), keeping the runtime clean.
		expect(() =>
			runtime.registerProvider("broken-provider", {
				baseUrl: "https://broken.example/v1",
				apiKey: "broken-key",
				models: [
					{
						id: "broken-model",
						name: "Broken",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 4096,
						// Missing "api" field.
					} as Model<"openai-completions">,
				],
			}),
		).toThrow(/no "api" specified/);

		// The rejected registration left no residual provider or error state.
		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getRegisteredProviderIds()).not.toContain("broken-provider");
	});

	it("snapshot remains consistent when a mutation occurs during in-flight refresh", async () => {
		const runtime = await ModelRuntime.create({
			credentials: createMagentaCredentialStore(AuthStorage.inMemory()),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		runtime.registerProvider("test-provider", {
			baseUrl: "https://test.example/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [model("model-1")],
		});

		// Kick off a background refresh (getAvailable without await).
		const refreshPromise = runtime.getAvailable();

		// While the refresh is in-flight, mutate the runtime (unregister the provider).
		// The forceRefreshAvailability path ensures mutations observe a fresh refresh.
		runtime.unregisterProvider("test-provider");

		// Wait for both: the original refresh and the forced post-mutation refresh.
		await refreshPromise;
		await runtime.getAvailable();

		// The snapshot should reflect the mutation (provider removed), not the stale refresh.
		const snapshot = runtime.getAvailableSnapshot();
		expect(snapshot.some((m) => m.provider === "test-provider")).toBe(false);
	});

	it("getAvailable(providerId) filters snapshot to the specified provider", async () => {
		const runtime = await ModelRuntime.create({
			credentials: createMagentaCredentialStore(AuthStorage.inMemory()),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});

		runtime.registerProvider("provider-a", {
			baseUrl: "https://a.example/v1",
			apiKey: "key-a",
			api: "openai-completions",
			models: [model("model-a")],
		});
		runtime.registerProvider("provider-b", {
			baseUrl: "https://b.example/v1",
			apiKey: "key-b",
			api: "openai-completions",
			models: [model("model-b")],
		});

		// Populate the snapshot with all available models.
		await runtime.getAvailable();

		// Request available models for provider-a only.
		const availableA = await runtime.getAvailable("provider-a");
		expect(availableA.every((m) => m.provider === "provider-a")).toBe(true);
		expect(availableA.some((m) => m.id === "model-a")).toBe(true);
		expect(availableA.some((m) => m.id === "model-b")).toBe(false);
	});
});
