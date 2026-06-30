/**
 * Command aliases and small editor conveniences.
 *
 * Current aliases:
 * - `exit`  -> `/quit`
 * - `clear` -> `/new`
 *
 * Autocomplete confirmation:
 * - When `/` command or `@` file-reference autocomplete is visible, Enter behaves
 *   like Tab: it accepts/cycles the current candidate instead of submitting.
 *
 * The editor is installed as a wrapper around any previously configured editor,
 * so it composes with ui-optimize's image-token editor instead of replacing it.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

import { EditorComponentWrapper } from "./shared/editor-wrapper.ts";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

function applyAlias(text: string): string {
	const trimmed = text.trim();
	if (trimmed === "exit") return "/quit";
	if (trimmed === "clear") return "/new";
	return text;
}

function hasAutocompleteTrigger(text: string): boolean {
	return /(^|\s)[/@][^\s]*$/.test(text.trimEnd());
}

class CommandAliasEditor extends CustomEditor {
	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			if (hasAutocompleteTrigger(this.getText()) && this.isShowingAutocomplete?.()) {
				super.handleInput("\t");
				return;
			}
			this.setText(applyAlias(this.getText()));
		}
		super.handleInput(data);
	}
}

class CommandAliasEditorWrapper extends EditorComponentWrapper {
	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			if (hasAutocompleteTrigger(this.inner.getText()) && this.isShowingAutocomplete()) {
				this.inner.handleInput?.("\t");
				return;
			}
			this.inner.setText(applyAlias(this.inner.getText()));
		}
		this.inner.handleInput?.(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const previous = ctx.ui.getEditorComponent() as EditorFactory | undefined;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			if (!previous) return new CommandAliasEditor(tui, theme, keybindings);
			return new CommandAliasEditorWrapper(previous(tui, theme, keybindings));
		});
	});
}
