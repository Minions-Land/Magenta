import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type CacheRequestRecord, fingerprintProviderPayload } from "../src/core/cache-telemetry.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const INITIAL_SENTINEL = "initial-provider-payload-sentinel";
const FINAL_SENTINEL = "final-extension-payload-sentinel";

describe("createAgentSession cache telemetry", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalTelemetry: string | undefined;

	beforeEach(() => {
		originalTelemetry = process.env.PI_CACHE_TELEMETRY;
		process.env.PI_CACHE_TELEMETRY = "1";
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-cache-telemetry-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (originalTelemetry === undefined) delete process.env.PI_CACHE_TELEMETRY;
		else process.env.PI_CACHE_TELEMETRY = originalTelemetry;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("fingerprints the final post-hook payload and falls back when a custom Codex provider omits wire observation", async () => {
		const model: Model<"openai-codex-responses"> = {
			id: "capture-model",
			name: "Capture Model",
			api: "openai-codex-responses",
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedFinalPayload: unknown;
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				const stream = createAssistantMessageEventStream();
				void (async () => {
					const initialPayload = {
						model: requestModel.id,
						input: [{ role: "user", content: INITIAL_SENTINEL }],
						stream: true,
					};
					capturedFinalPayload =
						(await providerOptions?.onPayload?.(initialPayload, requestModel)) ?? initialPayload;
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						usage: {
							input: 100,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 101,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				})();
				return stream;
			},
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
		});
		session.agent.onPayload = async (payload) => {
			const record = payload as Record<string, unknown>;
			return { ...record, input: [{ role: "user", content: FINAL_SENTINEL }] };
		};

		try {
			const stream = await session.agent.streamFn(model, { messages: [] }, { onPayload: session.agent.onPayload });
			await stream.result();
			expect(capturedOptions?.sessionId).toBe(sessionManager.getSessionId());
			expect(capturedFinalPayload).toMatchObject({
				input: [{ role: "user", content: FINAL_SENTINEL }],
			});

			const telemetryDirectory = join(agentDir, "telemetry", "cache");
			const key = Buffer.from(readFileSync(join(telemetryDirectory, "hmac.key"), "utf8").trim(), "hex");
			const records = readFileSync(join(telemetryDirectory, "events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as CacheRequestRecord | { type: string });
			const request = records.find((record): record is CacheRequestRecord => record.type === "cache_request");
			expect(request?.observation).toBe("logical_fallback");
			expect(request?.fingerprint).toEqual(fingerprintProviderPayload(capturedFinalPayload, model, key));

			const rawLog = JSON.stringify(records);
			expect(rawLog).not.toContain(INITIAL_SENTINEL);
			expect(rawLog).not.toContain(FINAL_SENTINEL);
		} finally {
			await session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
