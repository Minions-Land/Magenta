import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Credential,
	type CredentialStore,
	createAssistantMessageEventStream,
	createModels,
	type Model,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	AuthStorageCredentialAdapter,
	ExternalCredentialStore,
	getExternalBaseUrl,
	getExternalModel,
} from "../src/core/external-credential-adapter.ts";

describe("AuthStorageCredentialAdapter", () => {
	test("read returns stored api_key credential with resolved config value", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-ant-literal" },
		});
		const adapter = new AuthStorageCredentialAdapter(storage);

		const cred = await adapter.read("anthropic");
		expect(cred).toEqual({ type: "api_key", key: "sk-ant-literal" });
	});

	test("read resolves $ENV references in stored api_key", async () => {
		process.env.PI_TEST_ADAPTER_KEY = "resolved-key-value";
		try {
			const storage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "$" + "{PI_TEST_ADAPTER_KEY}" },
			});
			const adapter = new AuthStorageCredentialAdapter(storage);
			const cred = await adapter.read("anthropic");
			expect(cred).toEqual({ type: "api_key", key: "resolved-key-value" });
		} finally {
			delete process.env.PI_TEST_ADAPTER_KEY;
		}
	});

	test("read returns undefined for unknown provider", async () => {
		const storage = AuthStorage.inMemory({});
		const adapter = new AuthStorageCredentialAdapter(storage);
		expect(await adapter.read("nonexistent")).toBeUndefined();
	});

	test("list returns credential metadata without secrets", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-a" },
			openai: { type: "oauth", refresh: "r", access: "a", expires: 123 },
		});
		const adapter = new AuthStorageCredentialAdapter(storage);
		const list = await adapter.list();
		expect(list).toContainEqual({ providerId: "anthropic", type: "api_key" });
		expect(list).toContainEqual({ providerId: "openai", type: "oauth" });
	});

	test("modify persists a new credential and is serialized", async () => {
		const storage = AuthStorage.inMemory({});
		const adapter = new AuthStorageCredentialAdapter(storage);

		const result = await adapter.modify("anthropic", async (current) => {
			expect(current).toBeUndefined();
			return { type: "api_key", key: "sk-new" };
		});
		expect(result).toEqual({ type: "api_key", key: "sk-new" });

		// The write persisted: raw stored value is visible via get().
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "sk-new" });
	});

	test("modify returning undefined leaves the credential unchanged", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-keep" },
		});
		const adapter = new AuthStorageCredentialAdapter(storage);
		const result = await adapter.modify("anthropic", async () => undefined);
		expect(result).toEqual({ type: "api_key", key: "sk-keep" });
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "sk-keep" });
	});

	test("modify sees current credential for OAuth-style refresh", async () => {
		const storage = AuthStorage.inMemory({
			openai: { type: "oauth", refresh: "r0", access: "a0", expires: 100 },
		});
		const adapter = new AuthStorageCredentialAdapter(storage);
		const result = await adapter.modify("openai", async (current) => {
			expect(current).toEqual({ type: "oauth", refresh: "r0", access: "a0", expires: 100 });
			return { type: "oauth", refresh: "r1", access: "a1", expires: 200 } as Credential;
		});
		expect(result).toEqual({ type: "oauth", refresh: "r1", access: "a1", expires: 200 });
	});

	test("delete removes stored credential", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-a" },
		});
		const adapter = new AuthStorageCredentialAdapter(storage);
		await adapter.delete("anthropic");
		expect(storage.get("anthropic")).toBeUndefined();
	});
});

describe("ExternalCredentialStore", () => {
	let tempHome: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		tempHome = join(tmpdir(), `pi-test-external-cred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempHome, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = tempHome;
	});

	afterEach(() => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (tempHome && existsSync(tempHome)) rmSync(tempHome, { recursive: true });
	});

	function writeClaudeSettings(settings: Record<string, unknown>) {
		const claudeDir = join(tempHome, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings));
	}

	/** A minimal in-memory base store for isolating external-source behavior. */
	function memStore(initial: Record<string, Credential> = {}): CredentialStore {
		const data = new Map(Object.entries(initial));
		return {
			async read(id) {
				return data.get(id);
			},
			async list() {
				return [...data].map(([providerId, credential]) => ({ providerId, type: credential.type }));
			},
			async modify(id, fn) {
				const next = await fn(data.get(id));
				if (next !== undefined) data.set(id, next);
				return next ?? data.get(id);
			},
			async delete(id) {
				data.delete(id);
			},
		};
	}

	test("stored credential shadows external file", async () => {
		writeClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "external-token" } });
		const store = new ExternalCredentialStore(memStore({ anthropic: { type: "api_key", key: "stored-key" } }));
		const cred = await store.read("anthropic");
		expect(cred).toEqual({ type: "api_key", key: "stored-key" });
	});

	test("external file used when no stored credential", async () => {
		writeClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "external-token" } });
		const store = new ExternalCredentialStore(memStore({}));
		const cred = await store.read("anthropic");
		expect(cred).toEqual({
			type: "api_key",
			key: "external-token",
			env: { ANTHROPIC_AUTH_TOKEN: "external-token" },
		});
	});

	test("Codex custom base URL is carried as credential-scoped OpenAI request config", async () => {
		const store = new ExternalCredentialStore(memStore({}), () => [
			{
				provider: "openai",
				apiKey: "external-openai-key",
				baseUrl: "https://proxy.example/v1",
				source: "codex",
			},
		]);
		expect(await store.read("openai")).toEqual({
			type: "api_key",
			key: "external-openai-key",
			env: { OPENAI_BASE_URL: "https://proxy.example/v1" },
		});
	});

	test("routes an OpenAI model request through the Codex custom base URL", async () => {
		const store = new ExternalCredentialStore(memStore({}), () => [
			{
				provider: "openai",
				apiKey: "external-openai-key",
				baseUrl: "http://127.0.0.1:4141/v1",
				source: "codex",
			},
		]);
		const models = createModels({ credentials: store });
		const provider = openaiProvider();
		let routedBaseUrl: string | undefined;
		const respond = (model: Model<any>) => {
			routedBaseUrl = model.baseUrl;
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		models.setProvider({ ...provider, stream: respond, streamSimple: respond });
		const model = provider.getModels()[0];
		if (!model) throw new Error("OpenAI provider has no model fixture");

		await models.completeSimple(model, {
			messages: [{ role: "user", content: "route test", timestamp: Date.now() }],
		});

		expect(routedBaseUrl).toBe("http://127.0.0.1:4141/v1");
	});

	test("read returns undefined when no source has a credential", async () => {
		const store = new ExternalCredentialStore(memStore({}));
		expect(await store.read("anthropic")).toBeUndefined();
	});

	test("list merges stored and external providers", async () => {
		writeClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "external-token" } });
		const store = new ExternalCredentialStore(memStore({ openai: { type: "api_key", key: "openai-key" } }));
		const list = await store.list();
		expect(list).toContainEqual({ providerId: "openai", type: "api_key" });
		expect(list).toContainEqual({ providerId: "anthropic", type: "api_key" });
	});

	test("modify targets the underlying store only", async () => {
		const base = memStore({});
		const store = new ExternalCredentialStore(base);
		await store.modify("anthropic", async () => ({ type: "api_key", key: "written" }));
		expect(await base.read("anthropic")).toEqual({ type: "api_key", key: "written" });
	});

	test("delete removes stored credential but external file survives (logout non-destruction)", async () => {
		writeClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "external-token" } });
		const store = new ExternalCredentialStore(memStore({ anthropic: { type: "api_key", key: "stored-key" } }));
		// Before logout: stored wins.
		expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });
		await store.delete("anthropic");
		// After logout: external file still discoverable, not deleted.
		expect(await store.read("anthropic")).toEqual({
			type: "api_key",
			key: "external-token",
			env: { ANTHROPIC_AUTH_TOKEN: "external-token" },
		});
		expect(existsSync(join(tempHome, ".claude", "settings.json"))).toBe(true);
	});

	test("getExternalBaseUrl surfaces Claude Code base URL", () => {
		writeClaudeSettings({
			env: { ANTHROPIC_AUTH_TOKEN: "external-token", ANTHROPIC_BASE_URL: "https://proxy.example/v1" },
		});
		expect(getExternalBaseUrl("anthropic")).toBe("https://proxy.example/v1");
	});

	test("getExternalModel surfaces Claude Code default model", () => {
		writeClaudeSettings({
			env: { ANTHROPIC_AUTH_TOKEN: "external-token", ANTHROPIC_MODEL: "claude-opus-4" },
		});
		expect(getExternalModel("anthropic")).toBe("claude-opus-4");
	});
});
