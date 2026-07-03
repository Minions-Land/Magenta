import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "../theme/theme.ts";
import { FLOATING_WINDOW_BODY_LINES, renderFloatingWindow } from "./floating-window.ts";

type ChatRole = "user" | "assistant" | "system";

type ChatItem = {
	role: ChatRole;
	text: string;
};

export type SideChatTuiLike = {
	requestRender: () => void;
};

function printableText(data: string): string {
	if (!data || data.startsWith("\x1b")) return "";
	return data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function deleteLastWord(text: string): string {
	return text.replace(/\s*\S+\s*$/, "");
}

export class SideChatOverlay implements Component, Focusable {
	focused = false;
	messages: ChatItem[] = [];
	input = "";
	busy = false;
	error?: string;
	scrollTop = 0;
	followBottom = true;
	lastBodyLength = 0;
	modelLabel: string;

	private closed = false;
	private currentAbortController?: AbortController;
	private tui: SideChatTuiLike;
	private theme: Theme;
	private done: () => void;
	private onSend: (text: string, signal: AbortSignal) => Promise<string>;

	constructor(
		tui: SideChatTuiLike,
		theme: Theme,
		done: () => void,
		onSend: (text: string, signal: AbortSignal) => Promise<string>,
		initialQuestion?: string,
		modelLabel = "model unknown",
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.onSend = onSend;
		this.modelLabel = modelLabel;
		if (initialQuestion?.trim()) {
			queueMicrotask(() => void this.send(initialQuestion.trim()));
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.currentAbortController?.abort();
		this.done();
	}

	async send(text: string): Promise<void> {
		if (this.closed || this.busy || !text.trim()) return;
		const abortController = new AbortController();
		this.currentAbortController = abortController;
		this.input = "";
		this.error = undefined;
		this.busy = true;
		this.messages.push({ role: "user", text });
		this.tui.requestRender();

		try {
			const answer = await this.onSend(text, abortController.signal);
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
				this.tui.requestRender();
			}
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollBy(-8);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollBy(8);
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollTo(0);
			return;
		}
		if (matchesKey(data, "end")) {
			this.followBottom = true;
			this.tui.requestRender();
			return;
		}
		if (this.busy) return;

		if (matchesKey(data, "enter")) {
			const text = this.input.trim();
			if (["exit", "quit", "/exit", "/quit"].includes(text.toLowerCase())) {
				this.close();
				return;
			}
			void this.send(text);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			this.input = this.input.slice(0, -1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.input = "";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+w")) {
			this.input = deleteLastWord(this.input);
			this.tui.requestRender();
			return;
		}

		const text = printableText(data).replace(/[\r\n]+/g, " ");
		if (text) {
			this.input += text;
			this.tui.requestRender();
		}
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
		return FLOATING_WINDOW_BODY_LINES;
	}

	buildBody(innerWidth: number): string[] {
		const body: string[] = [];
		const mdTheme = getMarkdownTheme();

		for (const message of this.messages) {
			if (message.role === "system" && !message.text.startsWith("Error:")) continue;

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
				for (const line of wrapTextWithAnsi(message.text, innerWidth)) body.push(this.theme.fg("dim", line));
			}
			body.push("");
		}

		if (this.messages.length === 0) {
			body.push(
				this.theme.fg(
					"dim",
					"Ask a quick side/btw question. This chat has no tools and will not touch the main thread.",
				),
				"",
			);
		}
		if (this.busy) body.push(this.theme.fg("dim", "thinking..."), "");
		return body;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 4);
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
		const status = this.busy ? "thinking" : `no tools · ${this.modelLabel}`;
		const visibleBody = body.slice(this.scrollTop, this.scrollTop + viewportLines);
		while (visibleBody.length < viewportLines) visibleBody.push("");

		const hint = this.theme.fg("dim", "enter send · ↑↓ scroll · esc close");
		const promptWidth = Math.max(1, contentWidth - visibleWidth(hint) - 4);
		const prompt = this.busy
			? this.theme.fg("dim", "waiting for response...")
			: `${this.theme.fg("accent", "›")} ${truncateToWidth(this.input, promptWidth, "...")}${this.focused ? CURSOR_MARKER : ""}`;
		const footer = `${prompt}  ${hint}`;

		return renderFloatingWindow({
			theme: this.theme,
			width,
			title: "side · btw",
			subtitle: range ? `${status} · ${range}` : status,
			body: visibleBody,
			footer,
		});
	}

	invalidate(): void {
		// No cached render state.
	}
}
