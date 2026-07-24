import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	loadSideChatConversations,
	SIDE_CHAT_SESSION_CUSTOM_TYPE,
	type SideChatHandoffRequest,
	SideChatManager,
	type SideChatPersistenceEvent,
} from "../src/core/side-chat.ts";
import { ToolProgressTracker } from "../src/core/tool-progress.ts";
import type { SideChatOverlay, SideChatOverlayResult } from "../src/modes/interactive/components/side-chat-overlay.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: completeSimpleMock,
}));

const NEW_CONVERSATION = "+ New side/btw conversation";

function assistantResponse(text: string, content?: Array<Record<string, unknown>>) {
	return {
		role: "assistant",
		content: content ?? [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "side-model",
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

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for condition");
}

function fakeTui() {
	return { requestRender: vi.fn(), terminal: { rows: 40 } };
}

function createContext(
	sessionManager: SessionManager,
	ui: {
		select: ReturnType<typeof vi.fn>;
		custom: ReturnType<typeof vi.fn>;
		confirm?: ReturnType<typeof vi.fn>;
		notify?: ReturnType<typeof vi.fn>;
	},
	model = { provider: "test-provider", id: "side-model" },
): ExtensionCommandContext {
	return {
		mode: "tui",
		model,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "test-key",
				headers: { "x-test": "1" },
				env: { TEST_ENV: "1" },
			})),
		},
		sessionManager,
		ui: {
			select: ui.select,
			custom: ui.custom,
			confirm: ui.confirm ?? vi.fn(async () => false),
			notify: ui.notify ?? vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
}

function appendSideEvent(session: SessionManager, event: SideChatPersistenceEvent): void {
	session.appendCustomEntry(SIDE_CHAT_SESSION_CUSTOM_TYPE, event);
}

function seedConversation(session: SessionManager, id = "side-history-1"): void {
	appendSideEvent(session, {
		version: 1,
		action: "created",
		conversationId: id,
		kind: "side",
		createdAt: 100,
		modelLabel: "test-provider/side-model",
	});
	appendSideEvent(session, {
		version: 1,
		action: "message",
		conversationId: id,
		role: "user",
		text: "Should this become delegated work?",
		at: 110,
	});
	appendSideEvent(session, {
		version: 1,
		action: "message",
		conversationId: id,
		role: "assistant",
		text: "Ask the main session to scope it first.",
		at: 120,
	});
}

describe("SideChatManager", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	it("opens a no-tools overlay, sends main context, and persists clean side messages", async () => {
		completeSimpleMock.mockResolvedValue(assistantResponse("side answer"));
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: [{ type: "text", text: "main question" }], timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "main answer" }],
			api: "test",
			provider: "test",
			model: "main",
			usage: assistantResponse("").usage,
			stopReason: "stop",
			timestamp: 2,
		});
		const toolProgress = new ToolProgressTracker();
		toolProgress.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "file.ts" },
		} as never);
		let overlay: SideChatOverlay | undefined;
		const custom = vi.fn(async (factory) => {
			overlay = factory(fakeTui(), {} as never, undefined, vi.fn());
			return { action: "close", draft: "" } as SideChatOverlayResult;
		});
		const ctx = createContext(session, { select: vi.fn(async () => NEW_CONVERSATION), custom });
		const manager = new SideChatManager({
			toolProgress,
			completeSimple: completeSimpleMock,
			appendEntry: (customType, data) => session.appendCustomEntry(customType, data),
			createConversationId: () => "side-new-1",
			copyText: vi.fn(async () => {}),
		});

		await manager.handleCommand("side", "What happened?", ctx);
		await waitFor(() => completeSimpleMock.mock.calls.length > 0);
		await waitFor(() => overlay?.messages.some((message) => message.role === "assistant") === true);

		const requestContext = completeSimpleMock.mock.calls[0][1];
		expect(requestContext.systemPrompt).toContain("persistent side-chat agent");
		expect(requestContext.messages[0].content[0].text).toContain("main question");
		expect(requestContext.messages[0].content[0].text).toContain("main answer");
		expect(requestContext.messages[1].content[0].text).toContain("Current main-agent tool progress snapshot");
		expect(requestContext.messages[1].content[0].text).toContain("Side-chat question:\nWhat happened?");
		expect(overlay?.messages).toContainEqual({ role: "assistant", text: "side answer" });
		expect(loadSideChatConversations(session)).toMatchObject([
			{
				id: "side-new-1",
				kind: "side",
				messages: [
					{ role: "user", text: "What happened?" },
					{ role: "assistant", text: "side answer" },
				],
			},
		]);
		expect(JSON.stringify(session.buildSessionContext().messages)).toContain("main question");
		expect(JSON.stringify(session.buildSessionContext().messages)).not.toContain("side answer");
	});

	it("strips reasoning thinking blocks from retained history", async () => {
		completeSimpleMock
			.mockResolvedValueOnce(
				assistantResponse("first answer", [
					{ type: "thinking", thinking: "internal reasoning", thinkingSignature: '{"id":"rs_abc"}' },
					{ type: "text", text: "first answer" },
				]),
			)
			.mockResolvedValueOnce(assistantResponse("second answer"));
		const session = SessionManager.inMemory();
		let overlay: SideChatOverlay | undefined;
		const ctx = createContext(session, {
			select: vi.fn(async () => NEW_CONVERSATION),
			custom: vi.fn(async (factory) => {
				overlay = factory(fakeTui(), {} as never, undefined, vi.fn());
				return { action: "close", draft: "" } as SideChatOverlayResult;
			}),
		});
		const manager = new SideChatManager({
			toolProgress: new ToolProgressTracker(),
			appendEntry: (customType, data) => session.appendCustomEntry(customType, data),
			copyText: vi.fn(async () => {}),
		});

		await manager.open("side", "first question", ctx);
		await waitFor(() => overlay?.messages.some((message) => message.text === "first answer") === true);
		await overlay!.send("second question");
		await waitFor(() => completeSimpleMock.mock.calls.length === 2);

		const secondCallMessages = completeSimpleMock.mock.calls[1][1].messages as Array<{
			role: string;
			content: Array<{ type: string; text?: string }>;
		}>;
		const assistantEntries = secondCallMessages.filter((message) => message.role === "assistant");
		expect(assistantEntries).toHaveLength(1);
		expect(assistantEntries[0]?.content).toEqual([{ type: "text", text: "first answer" }]);
		expect(assistantEntries[0]?.content.some((content) => content.type === "thinking")).toBe(false);
	});

	it("shows newest-first main-session Side/BTW history and reopens the selected conversation", async () => {
		const session = SessionManager.inMemory();
		seedConversation(session, "older-side");
		appendSideEvent(session, {
			version: 1,
			action: "created",
			conversationId: "newer-btw",
			kind: "btw",
			createdAt: 200,
			modelLabel: "test-provider/side-model",
		});
		appendSideEvent(session, {
			version: 1,
			action: "message",
			conversationId: "newer-btw",
			role: "user",
			text: "newer multiline\nquestion",
			at: 300,
		});
		let choices: string[] = [];
		let overlay: SideChatOverlay | undefined;
		const ctx = createContext(session, {
			select: vi.fn(async (_title, options: string[]) => {
				choices = options;
				return options.find((option) => option.includes("newer multiline"));
			}),
			custom: vi.fn(async (factory) => {
				overlay = factory(fakeTui(), {} as never, undefined, vi.fn());
				return { action: "close", draft: "" } as SideChatOverlayResult;
			}),
		});
		const manager = new SideChatManager({ toolProgress: new ToolProgressTracker(), copyText: vi.fn(async () => {}) });

		await manager.handleCommand("btw", "", ctx);

		expect(choices[0]).toBe(NEW_CONVERSATION);
		expect(choices[1]).toContain("btw · newer multiline question");
		expect(choices[2]).toContain("side · Should this become delegated work?");
		expect(overlay?.messages).toEqual([{ role: "user", text: "newer multiline\nquestion" }]);
	});

	it("requires confirmation, enqueues once, and reopens the original conversation", async () => {
		const session = SessionManager.inMemory();
		seedConversation(session);
		let overlayOpenCount = 0;
		let reopenedOverlay: SideChatOverlay | undefined;
		const custom = vi.fn(
			async (factory) =>
				new Promise<SideChatOverlayResult>((resolve) => {
					overlayOpenCount++;
					const overlay = factory(fakeTui(), {} as never, undefined, resolve);
					if (overlayOpenCount === 1) queueMicrotask(() => overlay.requestEnqueue());
					else {
						reopenedOverlay = overlay;
						queueMicrotask(() => overlay.close());
					}
				}),
		);
		const enqueueHumanHandoff = vi.fn(async (_request: SideChatHandoffRequest) => ({
			handoffId: "handoff-1",
			sessionId: "child-session-7",
		}));
		const notify = vi.fn();
		const ctx = createContext(session, {
			select: vi.fn(async (_title, options: string[]) =>
				options.find((option) => option.includes("delegated work")),
			),
			custom,
			confirm: vi.fn(async () => true),
			notify,
		});
		const manager = new SideChatManager({
			toolProgress: new ToolProgressTracker(),
			appendEntry: (customType, data) => session.appendCustomEntry(customType, data),
			enqueueHumanHandoff,
			copyText: vi.fn(async () => {}),
		});

		await manager.handleCommand("side", "", ctx);

		expect(enqueueHumanHandoff).toHaveBeenCalledTimes(1);
		expect(enqueueHumanHandoff.mock.calls[0]?.[0]).toMatchObject({
			confirmed: true,
			origin: "side",
			conversationId: "side-history-1",
			messageCount: 2,
			truncated: false,
		});
		expect(enqueueHumanHandoff.mock.calls[0]?.[0].context).toContain("Human: Should this become delegated work?");
		expect(reopenedOverlay?.enqueuedSessionId).toBe("child-session-7");
		expect(reopenedOverlay?.messages).toContainEqual({
			role: "assistant",
			text: "Ask the main session to scope it first.",
		});
		expect(loadSideChatConversations(session)[0]?.handoff).toMatchObject({ sessionId: "child-session-7" });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("waiting for its message"), "info");
	});

	it("does not enqueue when the human declines confirmation", async () => {
		const session = SessionManager.inMemory();
		seedConversation(session);
		let opens = 0;
		const ctx = createContext(session, {
			select: vi.fn(async (_title, options: string[]) =>
				options.find((option) => option.includes("delegated work")),
			),
			custom: vi.fn(
				async (factory) =>
					new Promise<SideChatOverlayResult>((resolve) => {
						opens++;
						const overlay = factory(fakeTui(), {} as never, undefined, resolve);
						queueMicrotask(() => (opens === 1 ? overlay.requestEnqueue() : overlay.close()));
					}),
			),
			confirm: vi.fn(async () => false),
		});
		const enqueueHumanHandoff = vi.fn();
		const manager = new SideChatManager({
			toolProgress: new ToolProgressTracker(),
			enqueueHumanHandoff,
			copyText: vi.fn(async () => {}),
		});

		await manager.handleCommand("side", "", ctx);

		expect(enqueueHumanHandoff).not.toHaveBeenCalled();
		expect(opens).toBe(2);
	});
});
