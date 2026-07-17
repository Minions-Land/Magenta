import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, SubmittedInput } from "../../src/core/agent-session.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function hasRenderableOutput(message: AssistantMessage): boolean {
	return message.content.some((content) => {
		if (content.type === "toolCall") return true;
		if (content.type === "text") return content.text.trim().length > 0;
		if (content.type === "thinking") return content.thinking.trim().length > 0;
		return false;
	});
}

async function startDeferredPrompt(harness: Harness, input: SubmittedInput) {
	const responseStarted = deferred<void>();
	const releaseResponse = deferred<AssistantMessage>();
	harness.setResponses([
		async () => {
			responseStarted.resolve();
			return releaseResponse.promise;
		},
	]);
	const prompt = harness.session.prompt(input.text, { withdrawable: input, images: input.images });
	await responseStarted.promise;
	return { prompt, releaseResponse };
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("AgentSession prompt withdrawal", () => {
	it("withdraws after more than three seconds when no output committed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
		const harness = await createHarness();
		harnesses.push(harness);
		const input = { text: "restore this" };
		const { prompt, releaseResponse } = await startDeferredPrompt(harness, input);
		vi.setSystemTime(Date.now() + 30_000);

		expect(harness.session.requestPromptWithdrawal()).toBe(true);
		expect(harness.session.requestPromptWithdrawal()).toBe(false);
		releaseResponse.resolve(fauxAssistantMessage("late output must be discarded"));
		await prompt;

		expect(harness.session.messages).toEqual([]);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual([]);
		expect(harness.eventsOfType("prompt_withdrawn")).toEqual([{ type: "prompt_withdrawn", input }]);
		expect(harness.eventsOfType("agent_end").at(-1)?.messages).toEqual([]);
		expect(harness.session.requestPromptWithdrawal()).toBe(false);
	});

	it("finalizes a preflight callback withdrawal without starting the provider", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let responseFactoryCalls = 0;
		harness.setResponses([
			() => {
				responseFactoryCalls++;
				return fauxAssistantMessage("must not run");
			},
		]);
		let withdrawalResult: boolean | undefined;
		const input = { text: "cancel during preflight" };

		await harness.session.prompt(input.text, {
			withdrawable: input,
			preflightResult: (success) => {
				if (success) withdrawalResult = harness.session.requestPromptWithdrawal();
			},
		});

		expect(withdrawalResult).toBe(true);
		expect(responseFactoryCalls).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.events).toEqual([{ type: "prompt_withdrawn", input }]);
	});

	it("closes eligibility before public agent_end listeners can request withdrawal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("")]);
		let requestDuringAgentEnd: boolean | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			requestDuringAgentEnd = harness.session.requestPromptWithdrawal();
			unsubscribe();
		});

		await harness.session.prompt("terminal boundary", { withdrawable: { text: "terminal boundary" } });

		expect(requestDuringAgentEnd).toBe(false);
		expect(harness.session.requestPromptWithdrawal()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["terminal boundary"]);
		expect(harness.sessionManager.getEntries()).toHaveLength(2);
		expect(harness.eventsOfType("prompt_withdrawn")).toEqual([]);
	});

	it("lets a same-tick cancellation from the empty assistant end beat persistence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("")]);
		let withdrawalResult: boolean | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			withdrawalResult = harness.session.requestPromptWithdrawal();
			unsubscribe();
		});

		await harness.session.prompt("same tick", { withdrawable: { text: "same tick" } });

		expect(withdrawalResult).toBe(true);
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.eventsOfType("prompt_withdrawn")).toHaveLength(1);
	});

	it("retains and reparents a custom child appended after the empty assistant start", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("late output")]);
		let customEntryId: string | undefined;
		let withdrawalResult: boolean | undefined;
		const withdrew = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "message_start" || event.message.role !== "assistant") return;
				customEntryId = harness.sessionManager.appendCustomEntry("concurrent", { retained: true });
				withdrawalResult = harness.session.requestPromptWithdrawal();
				unsubscribe();
				resolve();
			});
		});

		const prompt = harness.session.prompt("withdraw with child", {
			withdrawable: { text: "withdraw with child" },
		});
		await withdrew;
		await prompt;

		expect(withdrawalResult).toBe(true);
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toHaveLength(1);
		expect(harness.sessionManager.getEntry(customEntryId!)).toMatchObject({
			type: "custom",
			parentId: null,
			customType: "concurrent",
		});
	});

	it("keeps normal aborted state and persistence for a programmatic abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { prompt, releaseResponse } = await startDeferredPrompt(harness, { text: "programmatic" });

		harness.session.requestAbort();
		releaseResponse.resolve(fauxAssistantMessage("not delivered"));
		await prompt;

		expect(getUserTexts(harness)).toEqual(["programmatic"]);
		expect(getAssistantTexts(harness)).toEqual([""]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(harness.sessionManager.getEntries()).toHaveLength(2);
		expect(harness.eventsOfType("prompt_withdrawn")).toEqual([]);
	});

	it("does not make programmatic prompts withdrawable", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const responseStarted = deferred<void>();
		const releaseResponse = deferred<AssistantMessage>();
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				return releaseResponse.promise;
			},
		]);
		const prompt = harness.session.prompt("sdk prompt");
		await responseStarted.promise;

		expect(harness.session.requestPromptWithdrawal()).toBe(false);
		harness.session.requestAbort();
		releaseResponse.resolve(fauxAssistantMessage("not delivered"));
		await prompt;
		expect(getUserTexts(harness)).toEqual(["sdk prompt"]);
	});

	it.each([
		["text", fauxAssistantMessage("visible text")],
		["thinking", fauxAssistantMessage([fauxThinking("visible thought")])],
		["tool call", fauxAssistantMessage([fauxToolCall("read", { path: "file" })], { stopReason: "toolUse" })],
	] as const)("closes the withdrawal window on first renderable %s snapshot", async (_label, response) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([response]);
		let withdrawalResult: boolean | undefined;
		const sawOutput = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event: AgentSessionEvent) => {
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					hasRenderableOutput(event.message)
				) {
					withdrawalResult = harness.session.requestPromptWithdrawal();
					harness.session.agent.abort();
					unsubscribe();
					resolve();
				}
			});
		});

		const prompt = harness.session.prompt("commit output", { withdrawable: { text: "commit output" } });
		await sawOutput;
		await prompt;

		expect(withdrawalResult).toBe(false);
		expect(getUserTexts(harness)).toEqual(["commit output"]);
		expect(harness.eventsOfType("prompt_withdrawn")).toEqual([]);
	});

	it("closes eligibility synchronously on a tool execution start event", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as {
			_activePromptWithdrawal?: Record<string, unknown>;
			_capturePromptWithdrawalEvent(event: Record<string, unknown>): Record<string, unknown> | undefined;
			requestPromptWithdrawal(): boolean;
		};
		const transaction = {
			input: { text: "tool boundary" },
			userMessage: { role: "user", content: "tool boundary", timestamp: Date.now() },
			assistantMessages: new Set(),
			assistantEntryIds: new Set(),
			previousErrorMessage: undefined,
			outputCommitted: false,
			withdrawRequested: false,
			terminalSeen: false,
		};
		session._activePromptWithdrawal = transaction;

		session._capturePromptWithdrawalEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "read",
			args: { path: "file" },
		});

		expect(transaction.outputCommitted).toBe(true);
		expect(session.requestPromptWithdrawal()).toBe(false);
		session._activePromptWithdrawal = undefined;
	});

	it("allows a clean next submission without duplicating the withdrawn prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { prompt, releaseResponse } = await startDeferredPrompt(harness, { text: "first" });
		expect(harness.session.requestPromptWithdrawal()).toBe(true);
		releaseResponse.resolve(fauxAssistantMessage("discarded"));
		await prompt;

		harness.setResponses([fauxAssistantMessage("second response")]);
		await harness.session.prompt("second", { withdrawable: { text: "second" } });

		expect(getUserTexts(harness)).toEqual(["second"]);
		expect(getAssistantTexts(harness)).toEqual(["second response"]);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "user")
				.map((message) => (typeof message.content === "string" ? message.content : message.content[0]?.text)),
		).toEqual(["second"]);
	});
});
