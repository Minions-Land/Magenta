import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const DEFAULT_TEST_MODEL: Model<any> = {
	id: "rpc-test-model",
	name: "RPC Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_192,
};

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RuntimeOptions {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	extensionFactory?: ExtensionFactory;
}

async function createRuntimeHost(options: RuntimeOptions): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? DEFAULT_TEST_MODEL;

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	const extensionsResult = options.extensionFactory
		? await createTestExtensionsResult([options.extensionFactory], tempDir)
		: undefined;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			await session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: RuntimeOptions): Promise<{
	lineHandler: (line: string) => void;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runtimeHost, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits a versioned runtime manifest and exposes background controls", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ type: "runtime_manifest", protocolVersion: 1, mode: "rpc" }),
				);
			});

			lineHandler(JSON.stringify({ id: "background-list", type: "get_background_events" }));
			lineHandler(
				JSON.stringify({
					id: "background-cancel",
					type: "cancel_background_event",
					sourceId: "agents",
					eventId: "missing",
				}),
			);
			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				expect(records).toContainEqual(
					expect.objectContaining({
						id: "background-list",
						command: "get_background_events",
						success: true,
						data: { events: [] },
					}),
				);
				expect(records).toContainEqual(
					expect.objectContaining({
						id: "background-cancel",
						command: "cancel_background_event",
						success: true,
						data: { cancelled: false },
					}),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("acknowledges abort without waiting for agent settlement", async () => {
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		const blockingAbort = vi
			.spyOn(runtimeHost.session, "abort")
			.mockImplementation(() => new Promise<void>(() => undefined));
		const requestAbort = vi.spyOn(runtimeHost.session, "requestAbort");
		try {
			lineHandler(JSON.stringify({ id: "abort-now", type: "abort" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ id: "abort-now", command: "abort", success: true }),
				);
			});
			expect(requestAbort).toHaveBeenCalledOnce();
			expect(blockingAbort).not.toHaveBeenCalled();
		} finally {
			blockingAbort.mockRestore();
			requestAbort.mockRestore();
			await cleanup();
		}
	});

	it("accepts extension UI responses while session_start is still binding", async () => {
		let confirmed: boolean | undefined;
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionFactory: (pi) => {
				pi.on("session_start", async (_event, ctx) => {
					confirmed = await ctx.ui.confirm("Startup", "Continue?");
				});
			},
		});
		try {
			let requestId: string | undefined;
			await vi.waitFor(() => {
				const request = parseOutputLines(rpcIo.outputLines).find(
					(record) => record.type === "extension_ui_request" && record.method === "confirm",
				);
				expect(request?.id).toEqual(expect.any(String));
				requestId = request?.id as string;
			});

			lineHandler(JSON.stringify({ type: "extension_ui_response", id: requestId, confirmed: true }));
			await vi.waitFor(() => {
				expect(confirmed).toBe(true);
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ type: "runtime_manifest", protocolVersion: 1 }),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("rejects invalid execution profiles at the JSON boundary", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "profile-invalid", type: "set_execution_profile", profile: "warp" }));
			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((line) => line.id === "profile-invalid");
				expect(response).toMatchObject({
					type: "response",
					command: "set_execution_profile",
					success: false,
					error: "Invalid execution profile: warp",
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});
