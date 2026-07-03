import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	matchesKey,
} from "@earendil-works/pi-tui";
import {
	ImageTokenController,
	readClipboardFilePaths,
	type ImageTokenTheme,
} from "../../../core/image-tokens.ts";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";

type EditorInternals = {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	historyIndex: number;
	lastAction: string | null;
	pushUndoSnapshot: () => void;
	setCursorCol: (col: number) => void;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private imageTokens: ImageTokenController | undefined;
	private getImageTokenTheme: (() => ImageTokenTheme) | undefined;
	private scanTimers: Array<ReturnType<typeof setTimeout>> = [];
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void | Promise<void>;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	setImageTokenController(
		controller: ImageTokenController | undefined,
		getTheme?: () => ImageTokenTheme,
	): void {
		this.imageTokens = controller;
		this.getImageTokenTheme = getTheme;
	}

	clearImageTokens(): void {
		this.imageTokens?.clear();
	}

	transformImageTokenInput(text: string): string {
		return this.imageTokens?.transformInput(text).text ?? text;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		if (this.deleteImageTokenAtCursor(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			if (this.pasteClipboardFilePaths()) return;
			void this.onPasteImage?.();
			this.scheduleImageTokenScan();
			return;
		}

		// Autocomplete enhancement (migrated from command-aliases extension):
		// When autocomplete is showing and Enter is pressed, treat it as Tab
		if (matchesKey(data, "enter") && this.isShowingAutocomplete()) {
			// Check if text ends with autocomplete trigger (@file or /command)
			const text = this.getText().trimEnd();
			if (/(^|\s)[\/@][^\s]*$/.test(text)) {
				// Convert Enter to Tab to accept/cycle autocomplete
				super.handleInput("\t");
				return;
			}
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	override insertTextAtCursor(text: string): void {
		const next = this.imageTokens?.replaceClipboardPaths(text, this.getText()) ?? text;
		super.insertTextAtCursor(next);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const theme = this.getImageTokenTheme?.();
		if (!this.imageTokens || !theme) return lines;
		return this.imageTokens.render(lines, theme, width);
	}

	private pasteClipboardFilePaths(): boolean {
		if (!this.imageTokens) return false;
		const paths = readClipboardFilePaths();
		if (paths.length === 0) return false;

		const text = this.imageTokens.formatClipboardPaths(paths, this.getText());
		if (!text) return false;

		super.insertTextAtCursor(text);
		this.tui.requestRender();
		return true;
	}

	private deleteImageTokenAtCursor(data: string): boolean {
		if (!this.imageTokens) return false;

		const backward =
			this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace");
		const forward =
			this.keybindings.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete");
		if (!backward && !forward) return false;

		const writable = this as unknown as Partial<EditorInternals>;
		if (!writable.state || !writable.pushUndoSnapshot || !writable.setCursorCol) return false;

		const line = writable.state.lines[writable.state.cursorLine] || "";
		const range = this.imageTokens.findDeleteRange(line, writable.state.cursorCol, backward);
		if (!range) return false;

		writable.historyIndex = -1;
		writable.lastAction = null;
		writable.pushUndoSnapshot();
		writable.state.lines[writable.state.cursorLine] = line.slice(0, range.start) + line.slice(range.end);
		writable.setCursorCol(range.start);
		this.imageTokens.deleteAttachment(range.token);
		this.onChange?.(this.getText());
		this.tui.requestRender();
		return true;
	}

	private scheduleImageTokenScan(): void {
		if (!this.imageTokens) return;
		for (const timer of this.scanTimers) clearTimeout(timer);
		this.scanTimers = [80, 250, 600].map((delay) =>
			setTimeout(() => {
				const current = this.getText();
				const next = this.imageTokens?.replaceClipboardPaths(current);
				if (!next || next === current) return;
				this.setText(next);
				this.tui.requestRender();
			}, delay),
		);
	}
}
