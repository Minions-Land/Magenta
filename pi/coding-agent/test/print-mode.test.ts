import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const rawOutput = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rawOutput.lines.push(line),
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: {
		getHeader: () => object | undefined;
		getCwd: () => string;
		isPersisted: () => boolean;
	};
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	settingsManager: {
		isProjectTrusted: () => boolean;
		getRetryEnabled: () => boolean;
	};
	resourceLoader: {
		getExtensions: () => { extensions: never[] };
		getSkills: () => { skills: never[] };
		getPrompts: () => { prompts: never[] };
		getAgentsFiles: () => { agentsFiles: never[] };
		getPackageTools: () => { tools: never[] };
		getUserMcpTools: () => { tools: never[] };
		getSystemPrompt: () => undefined;
		getAppendSystemPrompt: () => never[];
	};
	model?: { provider: string; id: string; api: string };
	modelRegistry: {
		hasConfiguredAuth: ReturnType<typeof vi.fn>;
		getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
	};
	thinkingLevel: "off";
	executionProfile: "off";
	harnessCapabilities: { workflows: false; teammates: false };
	sessionId: string;
	sessionFile: undefined;
	sessionName: undefined;
	autoCompactionEnabled: boolean;
	isStreaming: boolean;
	steeringMode: "one-at-a-time";
	followUpMode: "one-at-a-time";
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	getActiveToolNames: () => string[];
	getAllTools: () => never[];
	getBackgroundEvents: ReturnType<typeof vi.fn>;
	waitForBackgroundIdle: ReturnType<typeof vi.fn>;
	waitForExternalActivationQuiescence: ReturnType<typeof vi.fn>;
	getSessionStats: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: {
			getHeader: () => undefined,
			getCwd: () => "/tmp/print-mode-test",
			isPersisted: () => false,
		},
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		settingsManager: {
			isProjectTrusted: () => true,
			getRetryEnabled: () => true,
		},
		resourceLoader: {
			getExtensions: () => ({ extensions: [] }),
			getSkills: () => ({ skills: [] }),
			getPrompts: () => ({ prompts: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getPackageTools: () => ({ tools: [] }),
			getUserMcpTools: () => ({ tools: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
		},
		model: undefined,
		modelRegistry: {
			hasConfiguredAuth: vi.fn(() => true),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })),
		},
		thinkingLevel: "off",
		executionProfile: "off",
		harnessCapabilities: { workflows: false, teammates: false },
		sessionId: "print-mode-test",
		sessionFile: undefined,
		sessionName: undefined,
		autoCompactionEnabled: true,
		isStreaming: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		getActiveToolNames: () => [],
		getAllTools: () => [],
		getBackgroundEvents: vi.fn(() => []),
		waitForBackgroundIdle: vi.fn(async () => true),
		waitForExternalActivationQuiescence: vi.fn(async () => true),
		getSessionStats: vi.fn(() => ({ sessionId: "print-mode-test" })),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

function outputRecords(): Array<Record<string, unknown>> {
	return rawOutput.lines
		.flatMap((line) => line.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
	rawOutput.lines = [];
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images, source: "print" });
		expect(session.waitForExternalActivationQuiescence).toHaveBeenCalledOnce();
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello", { source: "json" });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits a manifest before buffered startup events and one terminal run_end", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		session.bindExtensions.mockImplementation(async () => {
			const listener = session.subscribe.mock.calls.at(-1)?.[0] as ((event: object) => void) | undefined;
			listener?.({ type: "agent_start" });
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "go",
		});

		expect(exitCode).toBe(0);
		const records = outputRecords();
		expect(records.map(({ type }) => type)).toEqual(["runtime_manifest", "agent_start", "run_end"]);
		const manifest = records[0];
		const runEnd = records.at(-1);
		expect(manifest).toMatchObject({ protocolVersion: 1, mode: "json", sequence: 1 });
		expect(runEnd).toMatchObject({
			protocolVersion: 1,
			runId: manifest?.runId,
			status: "success",
			exitCode: 0,
		});
		expect(records.filter(({ type }) => type === "run_end")).toHaveLength(1);
	});

	it("reports JSON assistant failures in run_end and the process result", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
		});

		expect(exitCode).toBe(1);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			exitCode: 1,
			stopReason: "error",
			error: "provider failure",
		});
	});

	it("keeps non-interactive ctx.hasUI false while reporting denied dialogs", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		session.bindExtensions.mockImplementation(async (bindings) => {
			expect(bindings.hasUI).toBe(false);
			expect(await bindings.uiContext.confirm("Approve?", "Continue")).toBe(false);
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
		});

		expect(exitCode).toBe(0);
		expect(outputRecords()).toContainEqual(
			expect.objectContaining({
				type: "non_interactive_ui",
				method: "confirm",
				disposition: "denied",
			}),
		);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			nonInteractiveUi: { policy: "deny", requestCount: 1 },
		});
	});

	it("fails explicitly when non-interactive UI policy is error", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		vi.spyOn(console, "error").mockImplementation(() => {});
		session.bindExtensions.mockImplementation(async (bindings) => {
			await bindings.uiContext.confirm("Approve?", "Continue");
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			nonInteractiveUiPolicy: "error",
		});

		expect(exitCode).toBe(1);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			error: expect.stringContaining("confirm"),
		});
	});

	it("turns leftover background work into an explicit error when requested", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const backgroundEvent = {
			sourceId: "agents",
			sourceTitle: "agents",
			id: "agent_001",
			status: "running",
			startedAt: Date.now(),
			label: "review",
		};
		session.getBackgroundEvents.mockImplementation(() => [backgroundEvent]);
		runtimeHost.dispose.mockImplementation(async () => {
			backgroundEvent.status = "cancelled";
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			backgroundPolicy: "error",
		});

		expect(exitCode).toBe(1);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			background: {
				policy: "error",
				settled: false,
				events: [expect.objectContaining({ id: "agent_001", status: "cancelled" })],
			},
		});
	});

	it("fails if completed background returns cannot reach quiescence before finalization", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		session.waitForExternalActivationQuiescence.mockResolvedValue(false);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			backgroundPolicy: "wait",
			backgroundWaitTimeoutMs: 10,
		});

		expect(exitCode).toBe(1);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			error: "Timed out after 10ms settling external activations",
			background: { settled: false },
		});
	});

	it("waits for finite background work only under the explicit wait policy", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const backgroundEvent = {
			sourceId: "shell",
			sourceTitle: "shell",
			id: "bg_001",
			status: "running",
			startedAt: Date.now(),
			label: "tests",
		};
		session.getBackgroundEvents.mockImplementation(() => [backgroundEvent]);
		session.waitForBackgroundIdle.mockImplementation(async () => {
			backgroundEvent.status = "exited";
			return true;
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			backgroundPolicy: "wait",
			backgroundWaitTimeoutMs: 1_000,
		});

		expect(exitCode).toBe(0);
		expect(session.waitForBackgroundIdle).toHaveBeenCalled();
		expect(session.waitForExternalActivationQuiescence).toHaveBeenCalledTimes(2);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "success",
			background: { policy: "wait", settled: true },
		});
	});

	it("keeps signal exit code and terminal status consistent", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		const { session } = runtimeHost;
		const previousHandlers = new Set(process.listeners("SIGTERM"));
		let rejectPrompt: ((error: Error) => void) | undefined;
		session.prompt.mockImplementation(
			async () =>
				new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
				}),
		);
		session.abort.mockImplementation(async () => {
			rejectPrompt?.(new Error("aborted"));
		});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

		const running = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "wait",
		});
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
		const signalHandler = process.listeners("SIGTERM").find((handler) => !previousHandlers.has(handler));
		expect(signalHandler).toBeDefined();
		signalHandler?.("SIGTERM");

		await expect(running).resolves.toBe(143);
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "aborted",
			exitCode: 143,
			stopReason: "aborted",
			error: "Interrupted by SIGTERM",
		});
	});

	it("reports post-runtime startup failures through the JSON terminal contract", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			startupError: "extension failed to load",
		});

		expect(exitCode).toBe(1);
		expect(outputRecords().map(({ type }) => type)).toEqual(["runtime_manifest", "run_end"]);
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			exitCode: 1,
			error: "extension failed to load",
		});
	});

	it("validates model authentication without sending a prompt", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "old session text" }));
		const { session } = runtimeHost;
		session.model = { provider: "openai", id: "test-model", api: "openai-responses" };

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			validateOnly: true,
		});

		expect(exitCode).toBe(0);
		expect(session.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(session.model);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(outputRecords().at(-1)).toMatchObject({ type: "run_end", status: "success", exitCode: 0 });
	});

	it("reports authentication failures from validation as the terminal result", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "old session text" }));
		const { session } = runtimeHost;
		session.model = { provider: "openai", id: "test-model", api: "openai-responses" };
		session.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			validateOnly: true,
		});

		expect(exitCode).toBe(1);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(outputRecords().at(-1)).toMatchObject({
			type: "run_end",
			status: "error",
			exitCode: 1,
			error: expect.stringContaining("No API key found for openai"),
		});
	});
});
