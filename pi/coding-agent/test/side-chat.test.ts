import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { SideChatManager } from "../src/core/side-chat.ts";
import { ToolProgressTracker } from "../src/core/tool-progress.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: completeSimpleMock,
}));

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 25; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for condition");
}

describe("SideChatManager", () => {
	it("opens a no-tools overlay and sends context through completeSimple", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "side answer" }],
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
		});

		const toolProgress = new ToolProgressTracker();
		toolProgress.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "file.ts" },
		} as never);
		toolProgress.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { ok: true },
			isError: false,
		} as never);

		let overlay: { messages: Array<{ role: string; text: string }> } | undefined;
		const ctx = {
			mode: "tui",
			model: { provider: "test-provider", id: "side-model" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({
					ok: true,
					apiKey: "test-key",
					headers: { "x-test": "1" },
					env: { TEST_ENV: "1" },
				})),
			},
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: [{ type: "text", text: "main question" }] },
					},
					{
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "main answer" }] },
					},
				],
			},
			ui: {
				notify: vi.fn(),
				custom: vi.fn(async (factory) => {
					overlay = factory({ requestRender: vi.fn() }, {} as never, undefined, vi.fn());
				}),
			},
		} as unknown as ExtensionCommandContext;

		const manager = new SideChatManager({ toolProgress });
		await manager.handleCommand("side", "What happened?", ctx);
		await waitFor(() => completeSimpleMock.mock.calls.length > 0);

		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({ provider: "test-provider", id: "side-model" });
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
			headers: { "x-test": "1" },
			env: { TEST_ENV: "1" },
		});

		const requestContext = completeSimpleMock.mock.calls[0][1];
		expect(requestContext.systemPrompt).toContain("temporary side-chat agent");
		expect(requestContext.messages[0].content[0].text).toContain("main question");
		expect(requestContext.messages[0].content[0].text).toContain("main answer");
		expect(requestContext.messages[1].content[0].text).toContain("Current main-agent tool progress snapshot");
		expect(requestContext.messages[1].content[0].text).toContain("read");
		expect(requestContext.messages[1].content[0].text).toContain("Side-chat question:\nWhat happened?");

		await waitFor(() => overlay?.messages.some((message) => message.role === "assistant") === true);
		expect(overlay?.messages).toContainEqual({ role: "assistant", text: "side answer" });
	});

	it("strips reasoning thinking blocks from history so a second turn still gets an answer", async () => {
		completeSimpleMock.mockReset();
		// A reasoning model (e.g. gpt-5.6-sol) returns a thinking block plus text on the
		// first turn. If the raw response were stored in history, replaying its thinking
		// signature through the stateless completeSimple path would make the second turn
		// return only a reasoning item and no text ("(empty response)"). History must keep
		// text only.
		const mockUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		completeSimpleMock
			.mockResolvedValueOnce({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "internal reasoning", thinkingSignature: '{"id":"rs_abc"}' },
					{ type: "text", text: "first answer" },
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.6-sol",
				usage: mockUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				role: "assistant",
				content: [{ type: "text", text: "second answer" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.6-sol",
				usage: mockUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			});

		const toolProgress = new ToolProgressTracker();
		let overlay:
			| { send: (text: string) => Promise<void>; messages: Array<{ role: string; text: string }> }
			| undefined;
		const ctx = {
			mode: "tui",
			model: { provider: "openai", id: "gpt-5.6-sol" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {}, env: {} })),
			},
			sessionManager: { getBranch: () => [] },
			ui: {
				notify: vi.fn(),
				custom: vi.fn(async (factory) => {
					overlay = factory({ requestRender: vi.fn() }, {} as never, undefined, vi.fn());
				}),
			},
		} as unknown as ExtensionCommandContext;

		const manager = new SideChatManager({ toolProgress });
		await manager.open("first question", ctx);
		await waitFor(() => completeSimpleMock.mock.calls.length === 1);
		await waitFor(() => overlay?.messages.some((m) => m.role === "assistant") === true);

		if (!overlay) throw new Error("overlay was not created");
		await overlay.send("second question");
		await waitFor(() => completeSimpleMock.mock.calls.length === 2);

		expect(overlay.messages).toContainEqual({ role: "assistant", text: "first answer" });
		expect(overlay.messages).toContainEqual({ role: "assistant", text: "second answer" });

		// The history passed to the model must never carry a reasoning thinking block:
		// side-chat stores assistant replies as text only. (messages is shared by reference,
		// so by now it holds both assistant turns; the invariant is what matters.)
		const secondCallMessages = completeSimpleMock.mock.calls[1][1].messages as Array<{
			role: string;
			content: Array<{ type: string; text?: string }>;
		}>;
		const assistantEntries = secondCallMessages.filter((m) => m.role === "assistant");
		expect(assistantEntries.length).toBeGreaterThanOrEqual(1);
		for (const entry of assistantEntries) {
			expect(entry.content.every((c) => c.type === "text")).toBe(true);
			expect(entry.content.some((c) => c.type === "thinking")).toBe(false);
		}
		expect(assistantEntries.map((e) => e.content[0].text)).toContain("first answer");
	});
});
