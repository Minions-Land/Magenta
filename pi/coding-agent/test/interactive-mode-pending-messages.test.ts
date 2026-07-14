import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmittedInput = { text: string; images?: unknown[]; imageMarkers?: string[] };

type ImageContent = { type: "image"; mimeType: string; data: string };

type FeedContext = {
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	clearAllQueues: () => { steering: SubmittedInput[]; followUp: SubmittedInput[] };
	updatePendingMessagesDisplay: () => void;
	pushActivation: (activation: { type: "user_input"; input: SubmittedInput }) => void;
	ui: { requestRender: () => void };
	agent: { abort: () => void };
	combineSubmittedInputs: (inputs: SubmittedInput[]) => SubmittedInput;
};

type InteractiveModePrivate = {
	interruptAndFeedPendingMessages(this: FeedContext): void;
	combineSubmittedInputs(this: unknown, inputs: SubmittedInput[]): SubmittedInput;
	requeuePendingDraft(this: RequeueContext): boolean;
};

type RequeueContext = {
	pendingDraftInEditor: boolean;
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
		extensionRunner: { getCommand: (name: string) => unknown };
	};
	defaultEditor: {
		transformImageTokenInput: (text: string) => string;
		clearImageTokens: () => void;
	};
	editor: {
		getText: () => string;
		getExpandedText?: () => string;
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
		clearPasteMarkers?: () => void;
	};
	pendingImageController: { takeForText: (text: string) => SubmittedInput };
	queueCompactionMessage: (input: SubmittedInput, mode: "steer" | "followUp") => void;
	isExtensionCommand: (text: string) => boolean;
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createFeedContext(): FeedContext {
	return {
		compactionQueuedMessages: [],
		clearAllQueues: vi.fn(() => ({ steering: [], followUp: [] })),
		updatePendingMessagesDisplay: vi.fn(),
		pushActivation: vi.fn(),
		ui: { requestRender: vi.fn() },
		agent: { abort: vi.fn() },
		// interruptAndFeedPendingMessages calls this.combineSubmittedInputs; use the real one.
		combineSubmittedInputs: (inputs) => interactiveModePrototype.combineSubmittedInputs.call(null, inputs),
	};
}

function createRequeueContext(): RequeueContext {
	const context: RequeueContext = {
		pendingDraftInEditor: true,
		session: {
			isStreaming: true,
			isCompacting: false,
			prompt: vi.fn(async () => {}),
			extensionRunner: { getCommand: () => undefined },
		},
		defaultEditor: {
			transformImageTokenInput: (text) => text,
			clearImageTokens: vi.fn(),
		},
		editor: {
			getText: () => "draft text",
			addToHistory: vi.fn(),
			setText: vi.fn(),
			clearPasteMarkers: vi.fn(),
		},
		pendingImageController: { takeForText: (text) => ({ text }) },
		queueCompactionMessage: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return context;
}

describe("InteractiveMode pending messages", () => {
	describe("interruptAndFeedPendingMessages", () => {
		it("aborts without feeding when there are no pending messages", () => {
			const context = createFeedContext();
			interactiveModePrototype.interruptAndFeedPendingMessages.call(context);

			expect(context.agent.abort).toHaveBeenCalledTimes(1);
			expect(context.clearAllQueues).toHaveBeenCalledTimes(1);
			expect(context.pushActivation).not.toHaveBeenCalled();
		});

		it("interrupts and feeds all pending messages as one fresh prompt", () => {
			const context = createFeedContext();
			context.clearAllQueues = vi.fn(() => ({
				steering: [{ text: "first" }],
				followUp: [{ text: "second" }],
			}));
			interactiveModePrototype.interruptAndFeedPendingMessages.call(context);

			expect(context.clearAllQueues).toHaveBeenCalledTimes(1);
			expect(context.agent.abort).toHaveBeenCalledTimes(1);
			expect(context.pushActivation).toHaveBeenCalledWith({
				type: "user_input",
				input: { text: "first\n\nsecond" },
			});
		});

		it("combines images and markers from multiple pending messages", () => {
			const context = createFeedContext();
			const img1: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
			const img2: ImageContent = { type: "image", mimeType: "image/jpeg", data: "def" };
			context.clearAllQueues = vi.fn(() => ({
				steering: [{ text: "describe [paste #1 Image]", images: [img1], imageMarkers: ["[paste #1 Image]"] }],
				followUp: [{ text: "then [paste #2 Image]", images: [img2], imageMarkers: ["[paste #2 Image]"] }],
			}));
			interactiveModePrototype.interruptAndFeedPendingMessages.call(context);

			expect(context.pushActivation).toHaveBeenCalledWith({
				type: "user_input",
				input: {
					text: "describe [paste #1 Image]\n\nthen [paste #2 Image]",
					images: [img1, img2],
					imageMarkers: ["[paste #1 Image]", "[paste #2 Image]"],
				},
			});
		});
	});

	describe("combineSubmittedInputs", () => {
		it("joins text with blank lines and concatenates images", () => {
			const img1: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
			const img2: ImageContent = { type: "image", mimeType: "image/jpeg", data: "def" };
			const result = interactiveModePrototype.combineSubmittedInputs.call(null, [
				{ text: "first", images: [img1], imageMarkers: ["[paste #1 Image]"] },
				{ text: "second" },
				{ text: "third", images: [img2], imageMarkers: ["[paste #2 Image]"] },
			]);

			expect(result).toEqual({
				text: "first\n\nsecond\n\nthird",
				images: [img1, img2],
				imageMarkers: ["[paste #1 Image]", "[paste #2 Image]"],
			});
		});

		it("drops blank text but keeps its images", () => {
			const img: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
			const result = interactiveModePrototype.combineSubmittedInputs.call(null, [
				{ text: "first" },
				{ text: "  ", images: [img], imageMarkers: ["[paste #1 Image]"] },
				{ text: "last" },
			]);

			expect(result).toEqual({
				text: "first\n\nlast",
				images: [img],
				imageMarkers: ["[paste #1 Image]"],
			});
		});

		it("pads missing imageMarkers with empty strings", () => {
			const img: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
			const result = interactiveModePrototype.combineSubmittedInputs.call(null, [{ text: "text", images: [img] }]);

			expect(result).toEqual({
				text: "text",
				images: [img],
				imageMarkers: [""],
			});
		});

		it("returns text-only input when no images are present", () => {
			const result = interactiveModePrototype.combineSubmittedInputs.call(null, [{ text: "a" }, { text: "b" }]);

			expect(result).toEqual({ text: "a\n\nb" });
		});
	});

	describe("requeuePendingDraft", () => {
		it("re-queues the current editor draft as steering while streaming", () => {
			const context = createRequeueContext();
			const handled = interactiveModePrototype.requeuePendingDraft.call(context);

			expect(handled).toBe(true);
			expect(context.session.prompt).toHaveBeenCalledWith("draft text", {
				streamingBehavior: "steer",
				images: undefined,
				imageMarkers: undefined,
			});
			expect(context.editor.setText).toHaveBeenCalledWith("");
			expect(context.pendingDraftInEditor).toBe(false);
		});

		it("routes to the compaction queue while compacting", () => {
			const context = createRequeueContext();
			context.session.isStreaming = false;
			context.session.isCompacting = true;
			const handled = interactiveModePrototype.requeuePendingDraft.call(context);

			expect(handled).toBe(true);
			expect(context.queueCompactionMessage).toHaveBeenCalledWith({ text: "draft text" }, "steer");
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.pendingDraftInEditor).toBe(false);
		});

		it("falls through when the agent is idle", () => {
			const context = createRequeueContext();
			context.session.isStreaming = false;
			context.session.isCompacting = false;
			const handled = interactiveModePrototype.requeuePendingDraft.call(context);

			expect(handled).toBe(false);
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.pendingDraftInEditor).toBe(false);
		});

		it("falls through on empty draft without clearing the editor", () => {
			const context = createRequeueContext();
			context.editor.getText = () => "   ";
			const handled = interactiveModePrototype.requeuePendingDraft.call(context);

			expect(handled).toBe(false);
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.editor.setText).not.toHaveBeenCalled();
		});

		it("falls through for extension commands so submit can handle them", () => {
			const context = createRequeueContext();
			context.editor.getText = () => "/help";
			context.isExtensionCommand = vi.fn(() => true);
			const handled = interactiveModePrototype.requeuePendingDraft.call(context);

			expect(handled).toBe(false);
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.editor.setText).not.toHaveBeenCalled();
		});
	});
});
