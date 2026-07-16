/**
 * Rich Content Reference - 富内容引用系统
 *
 * 支持在 TUI 对话中引用和展示非文本内容（图片、PDF、HTML 等）
 * 提供两种交互方式：
 * 1. Ctrl+O - 内联展开/收起
 * 2. Cmd+左键 - 浮动窗口查看
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	hyperlink,
	Image,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { Theme } from "../theme/theme.ts";

/**
 * 富内容类型
 */
export type RichContentType = "image" | "pdf" | "html" | "markdown" | "code" | "chart" | "file";

/**
 * 富内容元数据
 */
export interface RichContentMetadata {
	title?: string;
	description?: string;
	width?: number;
	height?: number;
	pages?: number;
	size?: number;
	language?: string;
}

/**
 * 富内容引用
 */
export interface RichContentReference {
	type: RichContentType;
	path: string;
	mimeType?: string;
	metadata?: RichContentMetadata;
}

/**
 * 获取内容类型的图标
 */
function getIconForType(type: RichContentType): string {
	const icons: Record<RichContentType, string> = {
		image: "📎",
		pdf: "📄",
		html: "🌐",
		markdown: "📝",
		code: "💻",
		chart: "📊",
		file: "📁",
	};
	return icons[type] || "📎";
}

/**
 * 获取内容类型的描述
 */
function getTypeDescription(ref: RichContentReference): string {
	switch (ref.type) {
		case "image":
			if (ref.metadata?.width && ref.metadata?.height) {
				return `(${ref.metadata.width}×${ref.metadata.height})`;
			}
			return "(image)";
		case "pdf":
			if (ref.metadata?.pages) {
				return `(${ref.metadata.pages} pages)`;
			}
			return "(pdf)";
		case "html":
			return "(html)";
		case "markdown":
			return "(markdown)";
		case "code":
			if (ref.metadata?.language) {
				return `(${ref.metadata.language})`;
			}
			return "(code)";
		case "chart":
			return "(chart)";
		default:
			return "";
	}
}

/**
 * 富内容链接组件
 * 显示可交互的富内容引用链接
 */
export class RichContentLink implements Component, Focusable {
	focused = false;
	private reference: RichContentReference;
	private theme: Theme;
	private expanded = false;
	private onToggleExpand: () => void;
	private onOpenOverlay: () => void;

	constructor(reference: RichContentReference, theme: Theme, onToggleExpand: () => void, onOpenOverlay: () => void) {
		this.reference = reference;
		this.theme = theme;
		this.onToggleExpand = onToggleExpand;
		this.onOpenOverlay = onOpenOverlay;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	handleInput(data: string): void {
		// Ctrl+O: 切换展开/收起
		if (matchesKey(data, "ctrl+o")) {
			this.onToggleExpand();
			return;
		}

		// Enter 或 Space: 打开浮动窗口
		if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			this.onOpenOverlay();
			return;
		}
	}

	render(width: number): string[] {
		const icon = getIconForType(this.reference.type);
		const filename = this.reference.metadata?.title || basename(this.reference.path);
		const description = getTypeDescription(this.reference);
		const actionHint = this.expanded ? "[Ctrl+O 收起]" : "[Ctrl+O 展开 | Enter 浮窗]";
		const safeText = stripAnsi(`${icon} ${filename} ${description} ${actionHint}`).replace(/[\r\n]+/g, " ");
		const linkText = truncateToWidth(safeText, Math.max(0, width), "…");

		// Truncate before adding OSC 8 so the hyperlink always has a complete closing sequence.
		const displayText = hyperlink(
			linkText,
			`pi-internal://rich-content/${this.reference.type}?path=${encodeURIComponent(this.reference.path)}`,
		);
		const finalText = this.focused ? displayText + CURSOR_MARKER : displayText;

		return [this.theme.fg("mdLink", finalText)];
	}

	invalidate(): void {
		// No cache
	}
}

/**
 * 可展开的富内容组件
 * 包含链接和展开的内容
 */
export class ExpandableRichContent extends Container implements Focusable {
	focused = false;
	private reference: RichContentReference;
	private theme: Theme;
	private link: RichContentLink;
	private expanded = false;
	private contentComponent?: Component;
	private onOpenOverlay: () => void;

	constructor(reference: RichContentReference, theme: Theme, onOpenOverlay: () => void) {
		super();
		this.reference = reference;
		this.theme = theme;
		this.onOpenOverlay = onOpenOverlay;

		// 创建链接组件
		this.link = new RichContentLink(
			reference,
			theme,
			() => this.toggleExpand(),
			() => this.onOpenOverlay(),
		);

		this.addChild(this.link);
	}

	handleInput(data: string): void {
		// 转发给链接组件
		this.link.handleInput(data);
	}

	private toggleExpand(): void {
		this.expanded = !this.expanded;
		this.link.setExpanded(this.expanded);

		if (this.expanded) {
			this.loadAndShowContent();
		} else {
			this.hideContent();
		}
	}

	private loadAndShowContent(): void {
		// 根据类型加载和渲染内容
		try {
			this.contentComponent = this.createContentComponent();
			if (this.contentComponent) {
				this.addChild(new Spacer(1));
				this.addChild(this.contentComponent);
			}
		} catch (error) {
			const errorText = new Text(
				this.theme.fg("error", `Error loading content: ${error instanceof Error ? error.message : String(error)}`),
				1,
				0,
			);
			this.addChild(new Spacer(1));
			this.addChild(errorText);
		}
	}

	private hideContent(): void {
		// 移除内容组件
		this.clear();
		this.addChild(this.link);
	}

	private createContentComponent(): Component | undefined {
		switch (this.reference.type) {
			case "image":
				return this.createImageComponent();
			case "markdown":
				return this.createMarkdownComponent();
			case "code":
				return this.createCodeComponent();
			case "pdf":
			case "html":
			case "chart":
				// 这些类型建议使用浮动窗口查看
				return new Text(this.theme.fg("muted", `Press Enter to view in overlay window`), 1, 0);
			default:
				return new Text(this.theme.fg("muted", `Unsupported content type: ${this.reference.type}`), 1, 0);
		}
	}

	private createImageComponent(): Component {
		try {
			// 读取图片文件
			const imageData = readFileSync(this.reference.path);
			const base64Data = imageData.toString("base64");
			const mimeType = this.reference.mimeType || "image/png";

			// 创建 Image 组件
			const image = new Image(
				base64Data,
				mimeType,
				{ fallbackColor: (s: string) => this.theme.fg("muted", s) },
				{
					maxWidthCells: 60,
					maxHeightCells: 20,
					filename: basename(this.reference.path),
				},
			);

			return image;
		} catch (error) {
			return new Text(
				this.theme.fg("error", `Failed to load image: ${error instanceof Error ? error.message : String(error)}`),
				1,
				0,
			);
		}
	}

	private createMarkdownComponent(): Component {
		try {
			const content = readFileSync(this.reference.path, "utf-8");
			return new Markdown(content, 1, 0, {
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
		} catch (error) {
			return new Text(
				this.theme.fg(
					"error",
					`Failed to load markdown: ${error instanceof Error ? error.message : String(error)}`,
				),
				1,
				0,
			);
		}
	}

	private createCodeComponent(): Component {
		try {
			const content = readFileSync(this.reference.path, "utf-8");
			const language = this.reference.metadata?.language || "";

			// 使用 Markdown 的代码块渲染
			const codeBlock = `\`\`\`${language}\n${content}\n\`\`\``;
			return new Markdown(codeBlock, 1, 0, {
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
		} catch (error) {
			return new Text(
				this.theme.fg("error", `Failed to load code: ${error instanceof Error ? error.message : String(error)}`),
				1,
				0,
			);
		}
	}
}

/**
 * 从文件路径自动识别富内容类型
 */
export function detectRichContentType(path: string): RichContentType {
	const ext = path.toLowerCase().split(".").pop();

	const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
	const codeExts = ["js", "ts", "py", "java", "cpp", "c", "go", "rs", "rb", "php"];

	if (imageExts.includes(ext || "")) return "image";
	if (ext === "pdf") return "pdf";
	if (ext === "html" || ext === "htm") return "html";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (codeExts.includes(ext || "")) return "code";

	return "file";
}

/**
 * 创建富内容引用
 */
export function createRichContentReference(path: string, metadata?: RichContentMetadata): RichContentReference {
	const type = detectRichContentType(path);
	const ext = path.toLowerCase().split(".").pop();

	let mimeType: string | undefined;
	if (type === "image") {
		mimeType = `image/${ext}`;
	}

	return {
		type,
		path,
		mimeType,
		metadata,
	};
}
