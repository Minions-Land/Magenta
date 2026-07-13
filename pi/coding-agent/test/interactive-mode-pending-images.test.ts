import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { SubmittedInput } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PendingImageContext = {
	editor: {
		getText: () => string;
		createPasteMarker?: (label: string) => { id: number; marker: string };
		insertPasteMarker?: (label: string) => { id: number; marker: string };
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
		clearPasteMarkers?: () => void;
	};
	pendingImageController: {
		add: (marker: string, image: ImageContent) => void;
	};
	compactionQueuedMessages: Array<SubmittedInput & { mode: "steer" | "followUp" }>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	ui: { requestRender: () => void };
	clipboardImageDraftGeneration: number;
	isShuttingDown: boolean;
	insertPendingImage(image: ImageContent, targetEditor?: PendingImageContext["editor"], generation?: number): boolean;
	restoreQueuedInput(input: SubmittedInput): string;
	restoreSubmittedInputToEditor(input: SubmittedInput): void;
	queueCompactionMessage(input: SubmittedInput, mode: "steer" | "followUp"): void;
};

function createContext(): PendingImageContext {
	let pasteId = 0;
	const context = Object.create(InteractiveMode.prototype) as PendingImageContext;
	Object.assign(context, {
		editor: {
			getText: () => "",
			createPasteMarker: vi.fn(() => {
				const id = ++pasteId;
				return { id, marker: `[paste #${id} Image]` };
			}),
			insertPasteMarker: vi.fn(() => {
				const id = ++pasteId;
				return { id, marker: `[paste #${id} Image]` };
			}),
			addToHistory: vi.fn(),
			setText: vi.fn(),
			clearPasteMarkers: vi.fn(),
		},
		pendingImageController: { add: vi.fn() },
		compactionQueuedMessages: [],
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		ui: { requestRender: vi.fn() },
		clipboardImageDraftGeneration: 0,
		isShuttingDown: false,
	});
	return context;
}

function image(data: string): ImageContent {
	return { type: "image", mimeType: "image/png", data };
}

describe("InteractiveMode pending image lifecycle", () => {
	it("inserts the exact clipboard marker and binds its ImageContent", () => {
		const context = createContext();
		const pasted = image("clipboard");

		expect(context.insertPendingImage(pasted)).toBe(true);
		expect(context.pendingImageController.add).toHaveBeenCalledWith("[paste #1 Image]", pasted);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("renumbers image markers when multiple queued drafts are restored", () => {
		const context = createContext();
		const first = image("first");
		const second = image("second");

		expect(
			context.restoreQueuedInput({
				text: "one [paste #1 Image]",
				images: [first],
				imageMarkers: ["[paste #1 Image]"],
			}),
		).toBe("one [paste #1 Image]");
		expect(
			context.restoreQueuedInput({
				text: "two [paste #1 Image]",
				images: [second],
				imageMarkers: ["[paste #1 Image]"],
			}),
		).toBe("two [paste #2 Image]");
		expect(context.pendingImageController.add).toHaveBeenNthCalledWith(1, "[paste #1 Image]", first);
		expect(context.pendingImageController.add).toHaveBeenNthCalledWith(2, "[paste #2 Image]", second);
	});

	it("rejects a paste that completed after its draft was invalidated", () => {
		const context = createContext();
		const targetEditor = context.editor;
		context.clipboardImageDraftGeneration = 2;

		expect(context.insertPendingImage(image("stale"), targetEditor, 1)).toBe(false);
		expect(context.pendingImageController.add).not.toHaveBeenCalled();
		expect(targetEditor.insertPasteMarker).not.toHaveBeenCalled();
	});

	it("restores only the attachment marker identity after a prompt preflight failure", () => {
		const context = createContext();
		context.editor.getText = () => "later draft";
		const attached = image("retry");

		context.restoreSubmittedInputToEditor({
			text: "manual [paste #99 Image] real [paste #4 Image]",
			images: [attached],
			imageMarkers: ["[paste #4 Image]"],
		});

		expect(context.editor.setText).toHaveBeenCalledWith(
			"manual [paste #99 Image] real [paste #1 Image]\n\nlater draft",
		);
		expect(context.pendingImageController.add).toHaveBeenCalledWith("[paste #1 Image]", attached);
	});

	it("keeps image content in the compaction queue and clears editor markers", () => {
		const context = createContext();
		const input = {
			text: "inspect [paste #1 Image]",
			images: [image("queued")],
			imageMarkers: ["[paste #1 Image]"],
		};

		context.queueCompactionMessage(input, "followUp");

		expect(context.compactionQueuedMessages).toEqual([{ ...input, mode: "followUp" }]);
		expect(context.editor.addToHistory).toHaveBeenCalledWith(input.text);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.editor.clearPasteMarkers).toHaveBeenCalledTimes(1);
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});
});
