import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubmittedInput } from "../src/core/agent-session.ts";
import {
	InteractiveMode,
	SUBMITTED_INPUT_ESCAPE_RESTORE_WINDOW_MS,
} from "../src/modes/interactive/interactive-mode.ts";

type Attempt = {
	input: SubmittedInput;
	acceptedAt: number;
	escapeRestoreRequested: boolean;
	hasValidOutput: boolean;
	restored: boolean;
};

type AbortRestoreContext = {
	activeSubmittedInputAttempt?: Attempt;
	restoreSubmittedInputToEditor: (input: SubmittedInput) => void;
	beginSubmittedInputAttempt(input: SubmittedInput): Attempt;
	endSubmittedInputAttempt(attempt: Attempt): void;
	markActiveSubmittedInputEscapeAbort(): void;
	observeActiveSubmittedInputMessage(message: AssistantMessage, isFinal: boolean): void;
};

function createContext(): AbortRestoreContext {
	const context = Object.create(InteractiveMode.prototype) as AbortRestoreContext;
	context.restoreSubmittedInputToEditor = vi.fn();
	return context;
}

function aborted(text = ""): AssistantMessage {
	return fauxAssistantMessage(text, { stopReason: "aborted" });
}

describe("InteractiveMode early Escape input restore", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([2_999, SUBMITTED_INPUT_ESCAPE_RESTORE_WINDOW_MS])(
		"restores an empty aborted attempt when Escape is pressed at %ims",
		(elapsed) => {
			const context = createContext();
			const input = { text: "check" };
			context.beginSubmittedInputAttempt(input);
			vi.setSystemTime(Date.now() + elapsed);
			context.markActiveSubmittedInputEscapeAbort();
			context.observeActiveSubmittedInputMessage(aborted(), true);

			expect(context.restoreSubmittedInputToEditor).toHaveBeenCalledOnce();
			expect(context.restoreSubmittedInputToEditor).toHaveBeenCalledWith(input);
		},
	);

	it("does not restore when Escape is pressed after the three-second window", () => {
		const context = createContext();
		context.beginSubmittedInputAttempt({ text: "too late" });
		vi.setSystemTime(Date.now() + SUBMITTED_INPUT_ESCAPE_RESTORE_WINDOW_MS + 1);
		context.markActiveSubmittedInputEscapeAbort();
		context.observeActiveSubmittedInputMessage(aborted(), true);
		expect(context.restoreSubmittedInputToEditor).not.toHaveBeenCalled();
	});

	it("does not restore a programmatic abort without the Escape-origin latch", () => {
		const context = createContext();
		context.beginSubmittedInputAttempt({ text: "programmatic" });
		context.observeActiveSubmittedInputMessage(aborted(), true);
		expect(context.restoreSubmittedInputToEditor).not.toHaveBeenCalled();
	});

	it("does not restore when text arrived before the abort", () => {
		const context = createContext();
		context.beginSubmittedInputAttempt({ text: "has output" });
		context.observeActiveSubmittedInputMessage(fauxAssistantMessage("partial"), false);
		context.markActiveSubmittedInputEscapeAbort();
		context.observeActiveSubmittedInputMessage(aborted(), true);
		expect(context.restoreSubmittedInputToEditor).not.toHaveBeenCalled();
	});

	it("does not restore when thinking or a tool call arrived", () => {
		for (const content of [
			[{ type: "thinking" as const, thinking: "working" }],
			[{ type: "toolCall" as const, id: "call_1", name: "read", arguments: { path: "x" } }],
		]) {
			const context = createContext();
			context.beginSubmittedInputAttempt({ text: "semantic output" });
			context.observeActiveSubmittedInputMessage({ ...aborted(), content }, false);
			context.markActiveSubmittedInputEscapeAbort();
			context.observeActiveSubmittedInputMessage(aborted(), true);
			expect(context.restoreSubmittedInputToEditor).not.toHaveBeenCalled();
		}
	});

	it("rejects restoration when non-empty final content arrives after Escape", () => {
		const context = createContext();
		context.beginSubmittedInputAttempt({ text: "late delta" });
		context.markActiveSubmittedInputEscapeAbort();
		context.observeActiveSubmittedInputMessage(aborted("buffered answer"), true);
		expect(context.restoreSubmittedInputToEditor).not.toHaveBeenCalled();
	});

	it("treats whitespace-only output as empty and restores attachments unchanged", () => {
		const context = createContext();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "encoded" };
		const input: SubmittedInput = {
			text: "inspect [paste #1 Image]",
			images: [image],
			imageMarkers: ["[paste #1 Image]"],
		};
		context.beginSubmittedInputAttempt(input);
		context.observeActiveSubmittedInputMessage(fauxAssistantMessage("   "), false);
		context.markActiveSubmittedInputEscapeAbort();
		context.observeActiveSubmittedInputMessage(aborted(), true);

		expect(context.restoreSubmittedInputToEditor).toHaveBeenCalledWith({
			...input,
			images: [image],
			imageMarkers: ["[paste #1 Image]"],
		});
	});

	it("clears only the matching attempt token", () => {
		const context = createContext();
		const first = context.beginSubmittedInputAttempt({ text: "first" });
		const second = context.beginSubmittedInputAttempt({ text: "second" });
		context.endSubmittedInputAttempt(first);
		expect(context.activeSubmittedInputAttempt).toBe(second);
		context.endSubmittedInputAttempt(second);
		expect(context.activeSubmittedInputAttempt).toBeUndefined();
	});
});
