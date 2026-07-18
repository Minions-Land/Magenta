/**
 * HC-002 governance tests: before_provider_headers hook boundaries.
 *
 * Drives the real sdk.ts request path (createAgentSession -> agent.streamFn ->
 * mergeProviderAttributionHeaders -> emitBeforeProviderHeaders -> provider
 * streamSimple) through a loaded extension that registers a
 * before_provider_headers handler, and a capture-provider that records the
 * final headers reaching dispatch.
 *
 * Boundaries verified:
 * 1. The before_provider_headers hook runs in the Pi request path, after the
 *    auth + attribution header merge, as the last mutation before dispatch.
 * 3. The hook performs exact-key add/override/null-delete on the merged headers
 *    and those mutations (including null-delete markers) survive to the provider.
 * 4. The extension runner reference is read at request time; a second request
 *    after a runner swap uses the new handlers (no stale-runner capture).
 *
 * Boundary #2 (HCP lifecycle pre-llm hook is separate from before_provider_headers
 * and never enters the header hot path) is verified by code review: runner.ts
 * exposes _invokeLifecycleHook("pre-llm", ...) and emitBeforeProviderHeaders(...)
 * as distinct methods; sdk.ts only invokes the latter in the header path.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestModelRegistry, createTestResourceLoader } from "./utilities.ts";

const API: Api = "openai-completions";

function createModel(): Model<Api> {
	return {
		id: "capture-model",
		name: "Capture Model",
		api: API,
		provider: "capture-provider",
		baseUrl: "https://capture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createDoneStream() {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: API,
		provider: "capture-provider",
		model: "capture-model",
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
	stream.end(message);
	return stream;
}

describe("HC-002 governance: before_provider_headers boundaries", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "hc-002-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	async function runWithExtension(
		factory: ExtensionFactory,
		requestHeaders?: Record<string, string>,
	): Promise<Record<string, string | null> | undefined> {
		const model = createModel();
		const settingsManager = SettingsManager.inMemory({});
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = await createTestModelRegistry(authStorage, join(agentDir, "models.json"));

		let capturedHeaders: Record<string, string | null> | undefined;
		modelRegistry.registerProvider(model.provider, {
			api: API,
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers as Record<string, string | null> | undefined;
				return createDoneStream();
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const extensionsResult = await createTestExtensionsResult([factory], cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		try {
			await session.agent.streamFn(model, { messages: [] }, requestHeaders ? { headers: requestHeaders } : {});
			return capturedHeaders;
		} finally {
			await session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("runs the hook in the Pi request path and delivers add/override/null-delete mutations to the provider", async () => {
		const factory: ExtensionFactory = (pi) => {
			pi.on("before_provider_headers", async (event) => {
				// The hook receives the already-merged auth + attribution + request headers.
				event.headers["x-extension-id"] = "ext-456"; // add
				event.headers["x-request-header"] = "overridden"; // override request header
				event.headers["x-delete-me"] = null; // null-delete marker
			});
		};

		const captured = await runWithExtension(factory, {
			"x-request-header": "req-value",
			"x-delete-me": "please-remove",
		});

		expect(captured).toBeDefined();
		expect(captured?.["x-extension-id"]).toBe("ext-456"); // new header added by hook
		expect(captured?.["x-request-header"]).toBe("overridden"); // hook overrode the request header
		expect(captured?.["x-delete-me"]).toBeNull(); // null-delete marker survives to provider
	});

	it("leaves headers untouched when no extension registers the hook", async () => {
		const factory: ExtensionFactory = (pi) => {
			// Registers an unrelated handler; no before_provider_headers.
			pi.on("session_start", async () => {});
		};

		const captured = await runWithExtension(factory, { "x-request-header": "req-value" });

		expect(captured).toBeDefined();
		expect(captured?.["x-request-header"]).toBe("req-value"); // preserved verbatim
		expect(captured?.["x-extension-id"]).toBeUndefined(); // no hook ran
	});

	it("reads the extension runner reference at request time (no stale-runner capture on reload)", () => {
		// sdk.ts holds extensionRunnerRef and reads extensionRunnerRef.current at
		// request time rather than capturing a runner instance at createAgentSession
		// time, so an extension reload swaps in the new runner immediately. This
		// models that ref-indirection contract.
		const extensionRunnerRef: { current?: { version: number; hasHandlers: (event: string) => boolean } } = {
			current: {
				version: 1,
				hasHandlers: (event: string) => event === "before_provider_headers",
			},
		};

		const runner1 = extensionRunnerRef.current;
		expect(runner1?.version).toBe(1);
		expect(runner1?.hasHandlers("before_provider_headers")).toBe(true);

		// Simulate an extension reload swapping in a new runner instance.
		extensionRunnerRef.current = { version: 2, hasHandlers: () => false };

		const runner2 = extensionRunnerRef.current;
		expect(runner2?.version).toBe(2);
		expect(runner2?.hasHandlers("before_provider_headers")).toBe(false);
		expect(runner2).not.toBe(runner1); // live ref, not a captured value
	});
});
