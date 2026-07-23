import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { AuthStorageCredentialAdapter } from "../src/core/external-credential-adapter.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const CODEX_CATALOG_PATH = "/api/models/providers/openai-codex";

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

afterEach(() => vi.restoreAllMocks());

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

		// /login stores the OAuth credential, then completeProviderAuthentication runs a full refresh.
		await authStorage.modify("openai-codex", async () => ({
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 3_600_000,
		}));
		await runtime.refresh();

		expect(codexCatalogCalls).toHaveLength(1);
		expect(runtime.getModels("openai-codex").map((m) => m.id)).toContain("gpt-5.6-luna");
		expect(runtime.getAvailableSnapshot().some((m) => m.provider === "openai-codex" && m.id === "gpt-5.6-luna")).toBe(
			true,
		);
	});
});
