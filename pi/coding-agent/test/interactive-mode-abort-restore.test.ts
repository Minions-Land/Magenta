import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { SubmittedInput } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme } from "../src/modes/interactive/theme/theme.ts";

type RestoreContext = {
	editor: {
		getText: () => string;
		setText: ReturnType<typeof vi.fn>;
		clearPasteMarkers: ReturnType<typeof vi.fn>;
		restorePasteMarkerSnapshot: ReturnType<typeof vi.fn>;
	};
	pendingImageController: {
		clear: ReturnType<typeof vi.fn>;
		add: ReturnType<typeof vi.fn>;
	};
	ui: { requestRender: ReturnType<typeof vi.fn> };
	restoreWithdrawnInputToEditor(input: SubmittedInput): void;
};

type ActiveInput = {
	input: SubmittedInput;
	preflightComplete: boolean;
	withdrawalRequested: boolean;
};

type KeyContext = {
	runtimeHost: { session: { isStreaming: boolean; requestPromptWithdrawal: ReturnType<typeof vi.fn> } };
	activeSubmittedInput?: ActiveInput;
	lastSigintTime: number;
	clearEditor: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	beginActiveSubmittedInput(input: SubmittedInput): ActiveInput;
	completeActiveSubmittedInputPreflight(activeInput: ActiveInput, success: boolean): void;
	handleEscape(): void;
	handleCtrlC(): void;
};

function createRestoreContext(currentText = "new unsent draft"): RestoreContext {
	const context = Object.create(InteractiveMode.prototype) as RestoreContext;
	context.editor = {
		getText: () => currentText,
		setText: vi.fn(),
		clearPasteMarkers: vi.fn(),
		restorePasteMarkerSnapshot: vi.fn(),
	};
	context.pendingImageController = { clear: vi.fn(), add: vi.fn() };
	context.ui = { requestRender: vi.fn() };
	return context;
}

describe("InteractiveMode prompt withdrawal restore", () => {
	it("replaces the current editor draft instead of concatenating it", () => {
		const context = createRestoreContext();
		context.restoreWithdrawnInputToEditor({ text: "withdrawn prompt" });

		expect(context.editor.setText).toHaveBeenCalledWith("withdrawn prompt");
		expect(context.editor.setText).not.toHaveBeenCalledWith(expect.stringContaining("new unsent draft"));
		expect(context.pendingImageController.clear).toHaveBeenCalledOnce();
	});

	it("restores exact image marker identities and re-registers their images", () => {
		const context = createRestoreContext();
		const first: ImageContent = { type: "image", mimeType: "image/png", data: "first" };
		const second: ImageContent = { type: "image", mimeType: "image/jpeg", data: "second" };
		const input: SubmittedInput = {
			text: "inspect [paste #7 Image] then [paste #12 Image]",
			images: [first, second],
			imageMarkers: ["[paste #7 Image]", "[paste #12 Image]"],
		};

		context.restoreWithdrawnInputToEditor(input);

		expect(context.editor.restorePasteMarkerSnapshot).toHaveBeenCalledWith({
			counter: 12,
			entries: [
				{ id: 7, marker: "[paste #7 Image]", expandedText: "[paste #7 Image]" },
				{ id: 12, marker: "[paste #12 Image]", expandedText: "[paste #12 Image]" },
			],
		});
		expect(context.pendingImageController.add).toHaveBeenNthCalledWith(1, "[paste #7 Image]", first);
		expect(context.pendingImageController.add).toHaveBeenNthCalledWith(2, "[paste #12 Image]", second);
		expect(context.editor.setText).toHaveBeenCalledWith(input.text);
	});

	it.each(["Escape", "Ctrl+C"] as const)("%s latches withdrawal while non-streaming preflight is pending", (key) => {
		const requestPromptWithdrawal = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
		const context = Object.create(InteractiveMode.prototype) as KeyContext;
		context.runtimeHost = { session: { isStreaming: false, requestPromptWithdrawal } };
		context.lastSigintTime = 0;
		context.clearEditor = vi.fn();
		context.shutdown = vi.fn();
		const activeInput = context.beginActiveSubmittedInput({ text: "pending preflight" });

		if (key === "Escape") context.handleEscape();
		else context.handleCtrlC();

		expect(activeInput.withdrawalRequested).toBe(true);
		expect(activeInput.preflightComplete).toBe(false);
		expect(context.clearEditor).not.toHaveBeenCalled();
		context.completeActiveSubmittedInputPreflight(activeInput, true);
		expect(activeInput.preflightComplete).toBe(true);
		expect(requestPromptWithdrawal).toHaveBeenCalledTimes(2);
	});

	it("routes Escape and Ctrl+C through TUI input into the withdrawal latch", () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		const context = Object.create(InteractiveMode.prototype) as KeyContext;
		context.runtimeHost = { session: { isStreaming: true, requestPromptWithdrawal: vi.fn(() => true) } };
		context.lastSigintTime = 0;
		context.clearEditor = vi.fn();
		context.shutdown = vi.fn();
		editor.onEscape = () => context.handleEscape();
		editor.onAction("app.clear", () => context.handleCtrlC());
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			terminal.sendInput("\x1b");
			terminal.sendInput("\x03");
		} finally {
			tui.stop();
		}

		expect(context.runtimeHost.session.requestPromptWithdrawal).toHaveBeenCalledTimes(2);
		expect(context.clearEditor).not.toHaveBeenCalled();
	});

	it("Ctrl+C tries synchronous prompt withdrawal before its normal clear behavior", () => {
		const context = Object.create(InteractiveMode.prototype) as KeyContext;
		context.runtimeHost = { session: { isStreaming: true, requestPromptWithdrawal: vi.fn(() => true) } };
		context.lastSigintTime = 0;
		context.clearEditor = vi.fn();
		context.shutdown = vi.fn();

		context.handleCtrlC();

		expect(context.runtimeHost.session.requestPromptWithdrawal).toHaveBeenCalledOnce();
		expect(context.clearEditor).not.toHaveBeenCalled();
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	it("Ctrl+C preserves normal behavior when output already committed", () => {
		const context = Object.create(InteractiveMode.prototype) as KeyContext;
		context.runtimeHost = { session: { isStreaming: true, requestPromptWithdrawal: vi.fn(() => false) } };
		context.lastSigintTime = 0;
		context.clearEditor = vi.fn();
		context.shutdown = vi.fn();

		context.handleCtrlC();

		expect(context.clearEditor).toHaveBeenCalledOnce();
	});
});
