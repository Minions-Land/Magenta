import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createMagentaCredentialStore } from "../src/core/external-credential-adapter.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const API: Api = "openai-completions";

function modelDefinition(id: string) {
	return {
		id,
		name: id,
		api: API,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

function completedStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
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
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

describe("session-scoped ModelRuntime dispatch", () => {
	const cleanup: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanup.length > 0) await cleanup.pop()?.();
	});

	async function createRuntime(providerId: string, response: string) {
		const runtime = await ModelRuntime.create({
			credentials: createMagentaCredentialStore(AuthStorage.inMemory()),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider(providerId, {
			api: API,
			apiKey: `${providerId}-key`,
			baseUrl: `https://${providerId}.invalid/v1`,
			models: [modelDefinition(`${providerId}-model`)],
			streamSimple: (model) => completedStream(model, response),
		});
		await runtime.refresh({ allowNetwork: false });
		const model = runtime.getModel(providerId, `${providerId}-model`);
		if (!model) throw new Error(`Missing test model for ${providerId}`);
		cleanup.push(async () => {
			runtime.unregisterProvider(providerId);
			await runtime.refresh({ allowNetwork: false });
		});
		return { runtime, model };
	}

	async function createSession(
		cwd: string,
		runtime: ModelRuntime,
		model: Model<Api>,
	): Promise<Awaited<ReturnType<typeof createAgentSession>>["session"]> {
		const session = (
			await createAgentSession({
				cwd,
				agentDir: cwd,
				model,
				modelRuntime: runtime,
				modelRegistry: new ModelRegistry(runtime),
				authStorage: AuthStorage.inMemory(),
				settingsManager: SettingsManager.inMemory({}),
				sessionManager: SessionManager.inMemory(cwd),
				resourceLoader: createTestResourceLoader(),
				noTools: "all",
			})
		).session;
		cleanup.push(() => session.dispose());
		return session;
	}

	async function requestText(session: Awaited<ReturnType<typeof createSession>>, model: Model<Api>): Promise<string> {
		const stream = await session.agent.streamFn(model, { messages: [] });
		const message = await stream.result();
		return message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
	}

	it("isolates same-API transports across runtimes and reload", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-runtime-dispatch-"));
		cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
		const a = await createRuntime("provider-a", "runtime-a");
		const sessionA = await createSession(cwd, a.runtime, a.model);

		// Register B last. A compat dispatch would now be captured by B's API-level override.
		const b = await createRuntime("provider-b", "runtime-b");
		const sessionB = await createSession(cwd, b.runtime, b.model);

		expect(await requestText(sessionA, a.model)).toBe("runtime-a");
		expect(await requestText(sessionB, b.model)).toBe("runtime-b");

		await sessionA.reload();

		expect(await requestText(sessionB, b.model)).toBe("runtime-b");
		expect(await requestText(sessionA, a.model)).toBe("runtime-a");
	});
});
