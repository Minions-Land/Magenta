import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_canContinueAfterCompaction: () => boolean;
};

describe("CC-007: pre-prompt compaction no-continue", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("_canContinueAfterCompaction returns false when last message is completed assistant with no queued messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Send a prompt resulting in a completed assistant turn
		harness.setResponses([fauxAssistantMessage("Completed response")]);
		await harness.session.prompt("test prompt");

		// After a normal assistant response with no tool calls and no queued messages,
		// agent.continue() would throw "Cannot continue from message role: assistant"
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const canContinue = sessionInternals._canContinueAfterCompaction();

		expect(canContinue).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1].role).toBe("assistant");
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("_canContinueAfterCompaction returns true when last message is user", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Push a user message into agent state (the source _canContinueAfterCompaction reads)
		harness.session.agent.state.messages.push({
			role: "user",
			content: [{ type: "text", text: "test" }],
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const canContinue = sessionInternals._canContinueAfterCompaction();

		expect(canContinue).toBe(true);
	});

	it("_canContinueAfterCompaction returns true when last message is toolResult", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Push a tool result message into agent state
		harness.session.agent.state.messages.push({
			role: "toolResult",
			toolName: "test_tool",
			toolCallId: "call_123",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const canContinue = sessionInternals._canContinueAfterCompaction();

		expect(canContinue).toBe(true);
	});

	it("_canContinueAfterCompaction returns true when assistant message has queued steering messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Send a prompt resulting in a completed assistant turn
		harness.setResponses([fauxAssistantMessage("Completed response")]);
		await harness.session.prompt("test prompt");

		// Queue a steering message
		harness.session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const canContinue = sessionInternals._canContinueAfterCompaction();

		expect(canContinue).toBe(true);
		expect(harness.session.messages[harness.session.messages.length - 1].role).toBe("assistant");
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("_canContinueAfterCompaction returns true when assistant message has queued follow-up messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Send a prompt resulting in a completed assistant turn
		harness.setResponses([fauxAssistantMessage("Completed response")]);
		await harness.session.prompt("test prompt");

		// Queue a follow-up message
		harness.session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const canContinue = sessionInternals._canContinueAfterCompaction();

		expect(canContinue).toBe(true);
		expect(harness.session.messages[harness.session.messages.length - 1].role).toBe("assistant");
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("_canContinueAfterCompaction returns false when there are no messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const canContinue = sessionInternals._canContinueAfterCompaction();

		expect(canContinue).toBe(false);
		expect(harness.session.messages).toHaveLength(0);
	});
});
