/**
 * Rich Content Overlay Viewers - 富内容浮动窗口查看器
 * 
 * 提供各种富内容的浮动窗口查看体验
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	Container,
	CURSOR_MARKER,
	type Component,
	type Focusable,
	Image,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import type { RichContentReference } from "./rich-content-reference.ts";

/**
 * 图片查看器
 * 支持缩放和滚动
 */
export class ImageViewer extends Container implements Focusable {
	focused = false;
	private reference: RichContentReference;
	private theme: Theme;
	private image?: Image;
	private error?: string;
	private zoomLevel = 1.0;
	private maxWidthCells = 80;
	private scrollOffset = 0;

	constructor(reference: RichContentReference, theme: Theme) {
		super();
		this.reference = reference;
		this.theme = theme;
		this.loadImage();
	}

	private loadImage(): void {
		try {
			const imageData = readFileSync(this.reference.path);
			const base64Data = imageData.toString("base64");
			const mimeType = this.reference.mimeType || "image/png";

			this.image = new Image(
				base64Data,
				mimeType,
				{ fallbackColor: (s: string) => this.theme.fg("muted", s) },
				{
					maxWidthCells: Math.floor(this.maxWidthCells * this.zoomLevel),
					filename: basename(this.reference.path),
				},
			);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "+") || matchesKey(data, "=")) {
			this.zoomIn();
		} else if (matchesKey(data, "-") || matchesKey(data, "_")) {
			this.zoomOut();
		} else if (matchesKey(data, "0")) {
			this.resetZoom();
		} else if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down")) {
			this.scrollOffset++;
		}
	}

	private zoomIn(): void {
		this.zoomLevel = Math.min(3.0, this.zoomLevel + 0.2);
		this.loadImage();
	}

	private zoomOut(): void {
		this.zoomLevel = Math.max(0.2, this.zoomLevel - 0.2);
		this.loadImage();
	}

	private resetZoom(): void {
		this.zoomLevel = 1.0;
		this.scrollOffset = 0;
		this.loadImage();
	}

	render(width: number): string[] {
		this.clear();

		// 标题
		const filename = basename(this.reference.path);
		this.addChild(new Text(this.theme.fg("accent", filename), 0, 0));
		this.addChild(new Spacer(1));

		// 图片或错误
		if (this.error) {
			this.addChild(new Text(this.theme.fg("error", `Error: ${this.error}`), 1, 0));
		} else if (this.image) {
			this.addChild(this.image);
		} else {
			this.addChild(new Text(this.theme.fg("muted", "Loading..."), 1, 0));
		}

		this.addChild(new Spacer(1));

		// 控制提示
		const zoomText = `Zoom: ${Math.round(this.zoomLevel * 100)}%`;
		const hints = `${zoomText} · +/- zoom · 0 reset · ↑↓ scroll · Esc close`;
		this.addChild(new Text(this.theme.fg("muted", hints), 0, 0));

		return super.render(width);
	}
}

/**
 * Markdown 文档查看器
 * 支持滚动
 */
export class MarkdownViewer extends Container implements Focusable {
	focused = false;
	private reference: RichContentReference;
	private theme: Theme;
	private content?: string;
	private error?: string;
	private scrollOffset = 0;
	private maxLines = 30;

	constructor(reference: RichContentReference, theme: Theme) {
		super();
		this.reference = reference;
		this.theme = theme;
		this.loadContent();
	}

	private loadContent(): void {
		try {
			this.content = readFileSync(this.reference.path, "utf-8");
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down")) {
			this.scrollOffset++;
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset += 10;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
		}
	}

	render(width: number): string[] {
		this.clear();

		// 标题
		const filename = basename(this.reference.path);
		this.addChild(new Text(this.theme.fg("accent", filename), 0, 0));
		this.addChild(new Spacer(1));

		// 内容或错误
		if (this.error) {
			this.addChild(new Text(this.theme.fg("error", `Error: ${this.error}`), 1, 0));
		} else if (this.content) {
			const markdown = new Markdown(this.content, 1, 0, {
				heading: (s: string) => this.theme.fg("accent", s),
				link: (s: string) => this.theme.fg("mdLink", s),
				linkUrl: (s: string) => this.theme.fg("muted", s),
				code: (s: string) => this.theme.fg("mdCode", s),
				codeBlock: (s: string) => this.theme.fg("mdCode", s),
				codeBlockBorder: (s: string) => this.theme.fg("border", s),
				quote: (s: string) => this.theme.fg("muted", s),
				quoteBorder: (s: string) => this.theme.fg("border", s),
				hr: (s: string) => this.theme.fg("border", s),
				listBullet: (s: string) => this.theme.fg("accent", s),
				bold: (s: string) => this.theme.bold(s),
				italic: (s: string) => this.theme.italic(s),
				strikethrough: (s: string) => this.theme.strikethrough(s),
				underline: (s: string) => this.theme.underline(s),
			});
			this.addChild(markdown);
		} else {
			this.addChild(new Text(this.theme.fg("muted", "Loading..."), 1, 0));
		}

		this.addChild(new Spacer(1));

		// 控制提示
		const hints = `↑↓ scroll · PgUp/PgDn page · Home top · Esc close`;
		this.addChild(new Text(this.theme.fg("muted", hints), 0, 0));

		return super.render(width);
	}
}

/**
 * 代码查看器
 * 支持语法高亮和滚动
 */
export class CodeViewer extends Container implements Focusable {
	focused = false;
	private reference: RichContentReference;
	private theme: Theme;
	private content?: string;
	private error?: string;
	private scrollOffset = 0;

	constructor(reference: RichContentReference, theme: Theme) {
		super();
		this.reference = reference;
		this.theme = theme;
		this.loadContent();
	}

	private loadContent(): void {
		try {
			this.content = readFileSync(this.reference.path, "utf-8");
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down")) {
			this.scrollOffset++;
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset += 10;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
		}
	}

	render(width: number): string[] {
		this.clear();

		// 标题
		const filename = basename(this.reference.path);
		const language = this.reference.metadata?.language || "";
		const title = language ? `${filename} (${language})` : filename;
		this.addChild(new Text(this.theme.fg("accent", title), 0, 0));
		this.addChild(new Spacer(1));

		// 内容或错误
		if (this.error) {
			this.addChild(new Text(this.theme.fg("error", `Error: ${this.error}`), 1, 0));
		} else if (this.content) {
			// 使用 Markdown 代码块渲染
			const codeBlock = "```" + language + "\n" + this.content + "\n```";
			const markdown = new Markdown(codeBlock, 1, 0, {
				heading: (s: string) => this.theme.fg("accent", s),
				link: (s: string) => this.theme.fg("mdLink", s),
				linkUrl: (s: string) => this.theme.fg("muted", s),
				code: (s: string) => this.theme.fg("mdCode", s),
				codeBlock: (s: string) => this.theme.fg("mdCode", s),
				codeBlockBorder: (s: string) => this.theme.fg("border", s),
				quote: (s: string) => this.theme.fg("muted", s),
				quoteBorder: (s: string) => this.theme.fg("border", s),
				hr: (s: string) => this.theme.fg("border", s),
				listBullet: (s: string) => this.theme.fg("accent", s),
				bold: (s: string) => this.theme.bold(s),
				italic: (s: string) => this.theme.italic(s),
				strikethrough: (s: string) => this.theme.strikethrough(s),
				underline: (s: string) => this.theme.underline(s),
			});
			this.addChild(markdown);
		} else {
			this.addChild(new Text(this.theme.fg("muted", "Loading..."), 1, 0));
		}

		this.addChild(new Spacer(1));

		// 控制提示
		const hints = `↑↓ scroll · PgUp/PgDn page · Home top · Esc close`;
		this.addChild(new Text(this.theme.fg("muted", hints), 0, 0));

		return super.render(width);
	}
}

/**
 * 通用文件查看器
 */
export class FileViewer extends Container implements Focusable {
	focused = false;
	private reference: RichContentReference;
	private theme: Theme;

	constructor(reference: RichContentReference, theme: Theme) {
		super();
		this.reference = reference;
		this.theme = theme;
	}

	handleInput(data: string): void {
		// 基础查看器不处理输入
	}

	render(width: number): string[] {
		this.clear();

		const filename = basename(this.reference.path);
		this.addChild(new Text(this.theme.fg("accent", filename), 0, 0));
		this.addChild(new Spacer(1));

		const type = this.reference.type.toUpperCase();
		this.addChild(new Text(this.theme.fg("muted", `${type} file viewer not yet implemented.`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("muted", "Press Esc to close"), 0, 0));

		return super.render(width);
	}
}

/**
 * 创建富内容查看器
 */
export function createRichContentViewer(reference: RichContentReference, theme: Theme): Component & Focusable {
	switch (reference.type) {
		case "image":
			return new ImageViewer(reference, theme);
		case "markdown":
			return new MarkdownViewer(reference, theme);
		case "code":
			return new CodeViewer(reference, theme);
		case "pdf":
		case "html":
		case "chart":
		case "file":
		default:
			return new FileViewer(reference, theme);
	}
}

/**
 * 获取查看器的最佳尺寸配置
 */
export function getViewerSize(type: string): "small" | "medium" | "large" | "xlarge" {
	switch (type) {
		case "image":
			return "large";
		case "pdf":
		case "markdown":
		case "code":
			return "xlarge";
		case "html":
		case "chart":
			return "xlarge";
		default:
			return "medium";
	}
}
