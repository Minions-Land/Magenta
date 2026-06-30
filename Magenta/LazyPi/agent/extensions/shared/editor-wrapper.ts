import type { AppKeybinding } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

export class EditorComponentWrapper implements EditorComponent {
	actionHandlers = new Map<AppKeybinding, () => void>();

	constructor(protected readonly inner: EditorComponent) {}

	get onEscape(): (() => void) | undefined { return (this.inner as EditorComponent & { onEscape?: () => void }).onEscape; }
	set onEscape(handler: (() => void) | undefined) { (this.inner as EditorComponent & { onEscape?: () => void }).onEscape = handler; }
	get onCtrlD(): (() => void) | undefined { return (this.inner as EditorComponent & { onCtrlD?: () => void }).onCtrlD; }
	set onCtrlD(handler: (() => void) | undefined) { (this.inner as EditorComponent & { onCtrlD?: () => void }).onCtrlD = handler; }
	get onPasteImage(): (() => void) | undefined { return (this.inner as EditorComponent & { onPasteImage?: () => void }).onPasteImage; }
	set onPasteImage(handler: (() => void) | undefined) { (this.inner as EditorComponent & { onPasteImage?: () => void }).onPasteImage = handler; }
	get onExtensionShortcut(): ((data: string) => boolean) | undefined { return (this.inner as EditorComponent & { onExtensionShortcut?: (data: string) => boolean }).onExtensionShortcut; }
	set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) { (this.inner as EditorComponent & { onExtensionShortcut?: (data: string) => boolean }).onExtensionShortcut = handler; }

	get focused(): boolean { return Boolean((this.inner as EditorComponent & { focused?: boolean }).focused); }
	set focused(value: boolean) { (this.inner as EditorComponent & { focused?: boolean }).focused = value; }
	get borderColor(): ((str: string) => string) | undefined { return this.inner.borderColor; }
	set borderColor(value: ((str: string) => string) | undefined) { this.inner.borderColor = value; }
	get onSubmit(): ((text: string) => void) | undefined { return this.inner.onSubmit; }
	set onSubmit(handler: ((text: string) => void) | undefined) { this.inner.onSubmit = handler; }
	get onChange(): ((text: string) => void) | undefined { return this.inner.onChange; }
	set onChange(handler: ((text: string) => void) | undefined) { this.inner.onChange = handler; }

	getText(): string { return this.inner.getText(); }
	setText(text: string): void { this.inner.setText(text); }
	getExpandedText(): string { return this.inner.getExpandedText?.() ?? this.inner.getText(); }
	addToHistory(text: string): void { this.inner.addToHistory?.(text); }
	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void { this.inner.setAutocompleteProvider?.(provider); }
	setPaddingX(padding: number): void { this.inner.setPaddingX?.(padding); }
	setAutocompleteMaxVisible(maxVisible: number): void { this.inner.setAutocompleteMaxVisible?.(maxVisible); }
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
		this.inner.onAction?.(action, handler);
	}
	invalidate(): void { this.inner.invalidate?.(); }
	insertTextAtCursor(text: string): void {
		if (this.inner.insertTextAtCursor) this.inner.insertTextAtCursor(text);
		else {
			this.inner.setText(this.inner.getText() + text);
			this.inner.onChange?.(this.inner.getText());
		}
	}
	render(width: number): string[] { return this.inner.render(width); }
	handleInput(data: string): void { this.inner.handleInput?.(data); }
	isShowingAutocomplete(): boolean { return (this.inner as EditorComponent & { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() ?? false; }
}
