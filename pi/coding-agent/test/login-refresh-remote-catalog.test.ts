import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { AuthStorageCredentialAdapter } from "../src/core/external-credential-adapter.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const CODEX_CATALOG_PATH = "/api/models/providers/openai-codex";
const tempDirectories: string[] = [];

function catalogModel(id: string) {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("login triggers remote catalog fetch", () => {
	it("exposes remote-catalog models for a provider right after its credential is stored", async () => {
		const codexCatalogCalls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes(CODEX_CATALOG_PATH)) {
				codexCatalogCalls.push(url);
				return new Response(JSON.stringify([catalogModel("gpt-5.6-luna")]), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const agentDir = mkdtempSync(join(tmpdir(), "magenta-login-catalog-"));
		tempDirectories.push(agentDir);
		writeFileSync(join(agentDir, "models.json"), "{}\n");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const runtime = await ModelRuntime.create({
			credentials: new AuthStorageCredentialAdapter(authStorage),
			modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "models-store.json"),
			allowModelNetwork: true,
		});

		// Unauthenticated providers are skipped by the refresh credential gate.
		expect(codexCatalogCalls).toHaveLength(0);
		expect(runtime.getModels("openai-codex").map((m) => m.id)).not.toContain("gpt-5.6-luna");

		runtime.registerProvider("openai-codex", {
			oauth: {
				name: "Test OAuth",
				login: async () => ({
					access: "test-access",
					refresh: "test-refresh",
					expires: Date.now() + 3_600_000,
				}),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});

		// The real /login owner persists the credential and refreshes the remote catalog.
		await runtime.login("openai-codex", "oauth", {
			prompt: async () => "",
			notify: () => {},
		});

		expect(codexCatalogCalls).toHaveLength(1);
		expect(authStorage.get("openai-codex")?.type).toBe("oauth");
		expect(runtime.getModels("openai-codex").map((m) => m.id)).toContain("gpt-5.6-luna");
		expect(runtime.getAvailableSnapshot().some((m) => m.provider === "openai-codex" && m.id === "gpt-5.6-luna")).toBe(
			true,
		);
	});

	it("leaves the previous credential unchanged when provider-owned login is cancelled", async () => {
		const authStorage = AuthStorage.inMemory({
			"openai-codex": { type: "api_key", key: "existing-key" },
		});
		const runtime = await ModelRuntime.create({
			credentials: new AuthStorageCredentialAdapter(authStorage),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("openai-codex", {
			oauth: {
				name: "Test OAuth",
				login: async (callbacks) => {
					await callbacks.onPrompt({ message: "Continue?" });
					return { access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});

		await expect(
			runtime.login("openai-codex", "oauth", {
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
		expect(authStorage.get("openai-codex")).toEqual({ type: "api_key", key: "existing-key" });
	});
});
