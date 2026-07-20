import { createProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function scopedStore(store: InMemoryModelsStore, providerId: string) {
	return {
		read: () => store.read(providerId),
		write: (entry: Parameters<InMemoryModelsStore["write"]>[1]) => store.write(providerId, entry),
		delete: () => store.delete(providerId),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it("parses keyed catalogs, sends the branded user agent, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => {
						throw new Error("not used");
					},
					streamSimple: () => {
						throw new Error("not used");
					},
				},
			}),
		);
		const store = new InMemoryModelsStore();

		// First refresh fetches; second is within the TTL and skips; forced refresh fetches again.
		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: scopedStore(store, provider.id),
			allowNetwork: true,
		});
		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: scopedStore(store, provider.id),
			allowNetwork: true,
		});
		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: scopedStore(store, provider.id),
			allowNetwork: true,
			force: true,
		});

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		// CC-058: Magenta branded UA (VERSION = BRAND_VERSION); no credential sent to catalog host.
		const requestHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(requestHeaders["User-Agent"]).toContain(`pi/${VERSION}`);
		expect(requestHeaders.Authorization).toBeUndefined();
		expect(requestHeaders["x-api-key"]).toBeUndefined();
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => {
						throw new Error("not used");
					},
					streamSimple: () => {
						throw new Error("not used");
					},
				},
			}),
		);
		const store = new InMemoryModelsStore();

		await expect(
			provider.refreshModels?.({
				credential: { type: "api_key" },
				store: scopedStore(store, provider.id),
				allowNetwork: true,
			}),
		).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});

	it("restores the persisted overlay offline without fetching", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => {
						throw new Error("not used");
					},
					streamSimple: () => {
						throw new Error("not used");
					},
				},
			}),
		);
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [model("cached")], checkedAt: Date.now() });

		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: scopedStore(store, provider.id),
			allowNetwork: false,
		});

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
