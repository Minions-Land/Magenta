import { describe, expect, it, vi } from "vitest";
import { SideChatManager } from "../src/core/side-chat.ts";
import { ToolProgressTracker } from "../src/core/tool-progress.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";

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
});
