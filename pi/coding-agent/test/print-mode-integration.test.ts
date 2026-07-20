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
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createTestExtensionsResult, createTestModelRegistry, createTestResourceLoader } from "./utilities.ts";

const TEST_MODEL: Model<any> = {
	id: "print-integration-model",
	name: "Print Integration Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_192,
};

const rawOutput = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rawOutput.lines.push(line),
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
		model: "print-integration-model",
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

function outputRecords(): Array<Record<string, unknown>> {
	return rawOutput.lines
		.flatMap((line) => line.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function createRuntimeHost(extensionFactory: ExtensionFactory): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-print-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createTestModelRegistry(authStorage, tempDir);
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const extensionsResult = await createTestExtensionsResult([extensionFactory], tempDir);
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
		dispose: vi.fn(async () => {
			await session.dispose();
		}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				await session.dispose();
			} catch {
				// ignore
			}
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

afterEach(() => {
	rawOutput.lines = [];
	vi.restoreAllMocks();
});

describe("runPrintMode integration with a real ExtensionRunner", () => {
	it("fails the run under --non-interactive-ui error even when the runner swallows the throw", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost((pi) => {
			pi.on("session_start", async (_event, ctx) => {
				await ctx.ui.confirm("Approve?", "Continue?");
			});
		});

		try {
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "json",
				nonInteractiveUiPolicy: "error",
			});

			expect(exitCode).toBe(1);
			const records = outputRecords();
			expect(records).toContainEqual(
				expect.objectContaining({ type: "non_interactive_ui", method: "confirm", disposition: "error" }),
			);
			expect(records.at(-1)).toMatchObject({
				type: "run_end",
				status: "error",
				exitCode: 1,
				error: expect.stringContaining("confirm"),
			});
		} finally {
			await cleanup();
		}
	});

	it("denies blocking UI by default while completing the run", async () => {
		let confirmed: boolean | undefined;
		const { runtimeHost, cleanup } = await createRuntimeHost((pi) => {
			pi.on("session_start", async (_event, ctx) => {
				confirmed = await ctx.ui.confirm("Approve?", "Continue?");
			});
		});

		try {
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "json",
			});

			expect(exitCode).toBe(0);
			expect(confirmed).toBe(false);
			const records = outputRecords();
			expect(records).toContainEqual(
				expect.objectContaining({ type: "non_interactive_ui", method: "confirm", disposition: "denied" }),
			);
			expect(records.at(-1)).toMatchObject({ type: "run_end", status: "success", exitCode: 0 });
		} finally {
			await cleanup();
		}
	});
});
