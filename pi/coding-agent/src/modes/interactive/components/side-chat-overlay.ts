import {
	type Component,
	Editor,
	type Focusable,
	Markdown,
	matchesKey,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getEditorTheme, getMarkdownTheme, type Theme } from "../theme/theme.ts";
import { FLOATING_WINDOW_BODY_LINES, renderFloatingWindow } from "./floating-window.ts";

export type SideChatRole = "user" | "assistant" | "system";

export type SideChatItem = {
	role: SideChatRole;
	text: string;
};

export type SideChatOverlayResult = { action: "close"; draft: string } | { action: "enqueue"; draft: string };

export type SideChatOverlayOptions = {
	initialQuestion?: string;
	initialDraft?: string;
	initialMessages?: SideChatItem[];
	modelLabel?: string;
	enqueuedSessionId?: string;
	onCopy?: (text: string) => Promise<void>;
};

export class SideChatOverlay implements Component, Focusable {
	messages: SideChatItem[];
	busy = false;
	error?: string;
	scrollTop = 0;
	followBottom = true;
	lastBodyLength = 0;
	modelLabel: string;
	enqueuedSessionId?: string;

	private _focused = false;
	private closed = false;
	private currentAbortController?: AbortController;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: SideChatOverlayResult) => void;
	private readonly onSend: (text: string, signal: AbortSignal) => Promise<string>;
	private readonly onCopy?: (text: string) => Promise<void>;
	private readonly editor: Editor;
	private lastViewportLines = FLOATING_WINDOW_BODY_LINES;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	get input(): string {
		return this.editor.getText();
	}

	set input(value: string) {
		this.editor.setText(value);
	}

	constructor(
		tui: TUI,
		theme: Theme,
		done: (result: SideChatOverlayResult) => void,
		onSend: (text: string, signal: AbortSignal) => Promise<string>,
		options: SideChatOverlayOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.onSend = onSend;
		this.onCopy = options.onCopy;
		this.modelLabel = options.modelLabel ?? "model unknown";
		this.enqueuedSessionId = options.enqueuedSessionId;
		this.messages = options.initialMessages?.map((message) => ({ ...message })) ?? [];
		this.editor = new Editor(tui, getEditorTheme(), { slashAutocomplete: false, paddingX: 0 });
		this.editor.onSubmit = (text) => void this.send(text);
		if (options.initialDraft) this.editor.setText(options.initialDraft);
		if (options.initialQuestion?.trim()) {
			queueMicrotask(() => void this.send(options.initialQuestion!.trim()));
		}
	}

	close(): void {
		this.finish({ action: "close", draft: this.editor.getText() });
	}

	requestEnqueue(): void {
		if (this.closed || this.busy) return;
		if (this.enqueuedSessionId) {
			this.pushSystem(`Already enqueued as ${this.enqueuedSessionId}.`);
			return;
		}
		if (!this.messages.some((message) => message.role === "user")) {
			this.pushSystem("Ask at least one question before enqueueing this conversation.");
			return;
		}
		this.finish({ action: "enqueue", draft: this.editor.getText() });
	}

	async send(text: string): Promise<void> {
		if (this.closed || this.busy || !text.trim()) return;
		const normalized = text.trim();
		const abortController = new AbortController();
		this.currentAbortController = abortController;
		this.editor.addToHistory(normalized);
		this.editor.setText("");
		this.error = undefined;
		this.busy = true;
		this.messages.push({ role: "user", text: normalized });
		this.followBottom = true;
		this.tui.requestRender();

		try {
			const answer = await this.onSend(normalized, abortController.signal);
			if (this.closed || abortController.signal.aborted) return;
			this.messages.push({ role: "assistant", text: answer.trim() || "(empty response)" });
		} catch (error) {
			if (this.closed || abortController.signal.aborted) return;
			this.error = error instanceof Error ? error.message : String(error);
			this.messages.push({ role: "system", text: `Error: ${this.error}` });
		} finally {
			if (this.currentAbortController === abortController) this.currentAbortController = undefined;
			if (!this.closed) {
				this.busy = false;
				this.followBottom = true;
				this.tui.requestRender();
			}
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			void this.copyCurrentText();
			return;
		}
		if (matchesKey(data, "ctrl+t")) {
			this.requestEnqueue();
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scrollBy(-8);
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
			this.scrollBy(8);
			return;
		}
		if (matchesKey(data, "ctrl+up")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, "ctrl+down")) {
			this.scrollBy(1);
			return;
		}
		if (this.busy) return;
		this.editor.handleInput(data);
	}

	scrollBy(delta: number): void {
		const viewportLines = this.bodyViewportLines();
		const maxTop = Math.max(0, this.lastBodyLength - viewportLines);
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop + delta));
		this.followBottom = this.scrollTop >= maxTop;
		this.tui.requestRender();
	}

	scrollTo(top: number): void {
		const viewportLines = this.bodyViewportLines();
		const maxTop = Math.max(0, this.lastBodyLength - viewportLines);
		this.scrollTop = Math.max(0, Math.min(maxTop, top));
		this.followBottom = this.scrollTop >= maxTop;
		this.tui.requestRender();
	}

	bodyViewportLines(): number {
		return this.lastViewportLines;
	}

	buildBody(innerWidth: number): string[] {
		const body: string[] = [];
		const mdTheme = getMarkdownTheme();

		for (const message of this.messages) {
			if (message.role === "user") {
				const wrapped = wrapTextWithAnsi(message.text || " ", Math.max(10, innerWidth - 6));
				const label = this.theme.fg("accent", "you ›");
				body.push(`${label} ${wrapped[0] ?? ""}`);
				for (const line of wrapped.slice(1)) body.push(`      ${line}`);
			} else if (message.role === "assistant") {
				body.push(this.theme.fg("success", "side ›"));
				const markdown = new Markdown(message.text || " ", 0, 0, mdTheme);
				body.push(...markdown.render(Math.max(10, innerWidth - 2)).map((line) => `  ${line}`));
			} else {
				for (const line of wrapTextWithAnsi(message.text, innerWidth)) {
					body.push(this.theme.fg(message.text.startsWith("Error:") ? "error" : "dim", line));
				}
			}
			body.push("");
		}

		if (this.messages.length === 0) {
			body.push(this.theme.fg("dim", "Start a no-tools side/btw conversation."), "");
		}
		if (this.busy) body.push(this.theme.fg("dim", "thinking..."), "");
		return body;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 4);
		const editorLines = this.busy
			? [this.theme.fg("dim", "waiting for response...")]
			: this.editor.render(contentWidth);
		const hintLines = [
			this.theme.fg("dim", "enter send · shift+enter newline · ctrl+c copy · ctrl+t enqueue"),
			this.theme.fg("dim", "ctrl+u/d or pgup/pgdn transcript · esc close"),
		];
		const footer = [...editorLines, ...hintLines];
		const maxWindowLines = Math.max(12, Math.floor(this.tui.terminal.rows * 0.82));
		this.lastViewportLines = Math.max(3, Math.min(FLOATING_WINDOW_BODY_LINES, maxWindowLines - footer.length - 3));

		const body = this.buildBody(contentWidth);
		const viewportLines = this.bodyViewportLines();
		this.lastBodyLength = body.length;
		const maxTop = Math.max(0, body.length - viewportLines);
		if (this.followBottom) this.scrollTop = maxTop;
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop));

		const range =
			body.length > viewportLines
				? `${this.scrollTop + 1}-${Math.min(body.length, this.scrollTop + viewportLines)}/${body.length}`
				: "";
		const statusParts = [this.busy ? "thinking" : `no tools · ${this.modelLabel}`];
		if (this.enqueuedSessionId) statusParts.push(`queued ${this.enqueuedSessionId}`);
		if (range) statusParts.push(range);
		const visibleBody = body.slice(this.scrollTop, this.scrollTop + viewportLines);
		while (visibleBody.length < viewportLines) visibleBody.push("");

		return renderFloatingWindow({
			theme: this.theme,
			width,
			title: "side · btw",
			subtitle: statusParts.join(" · "),
			body: visibleBody,
			footer,
		});
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private finish(result: SideChatOverlayResult): void {
		if (this.closed) return;
		this.closed = true;
		this.currentAbortController?.abort();
		this.done(result);
	}

	private async copyCurrentText(): Promise<void> {
		if (!this.onCopy || this.closed) return;
		const draft = this.editor.getText().trim();
		const latest = [...this.messages]
			.reverse()
			.find((message) => message.role === "assistant" || message.role === "user")?.text;
		const text = draft || latest;
		if (!text) {
			this.pushSystem("Nothing to copy yet.");
			return;
		}
		try {
			await this.onCopy(text);
			if (!this.closed) this.pushSystem(draft ? "Copied the current draft." : "Copied the latest message.");
		} catch (error) {
			if (!this.closed) this.pushSystem(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private pushSystem(text: string): void {
		this.messages.push({ role: "system", text });
		this.followBottom = true;
		this.tui.requestRender();
	}
}
