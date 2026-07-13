import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

export interface PasteMarkerSnapshot {
	counter: number;
	entries: Array<{ id: number; marker: string; expandedText: string }>;
}

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/** Allocate a registered atomic paste marker without inserting it. */
	createPasteMarker?(label: string, expandedText?: string): { id: number; marker: string };

	/** Register and insert an atomic paste marker using the editor's shared paste sequence. */
	insertPasteMarker?(label: string, expandedText?: string): { id: number; marker: string };

	/** Clear registered paste markers, their undo history, and restart numbering. */
	clearPasteMarkers?(): void;

	/** Export registered markers when replacing one editor component with another. */
	getPasteMarkerSnapshot?(): PasteMarkerSnapshot;

	/** Restore registered markers after replacing an editor component. */
	restorePasteMarkerSnapshot?(snapshot: PasteMarkerSnapshot): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
