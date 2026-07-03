/**
 * show tool - Display content in floating overlay
 * 
 * Integration layer between Harness show tool and Pi coding agent.
 */

import { existsSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface ContentItem {
	type: "image" | "pdf" | "html" | "markdown" | "code" | "chart" | "file";
	url: string;
	filename: string;
	mimeType?: string;
}

export interface ShowToolOptions {
	// Future: add options like max file size, allowed types, etc.
}

export interface ShowToolDetails {
	items: ContentItem[];
}

export interface ShowToolInput {
	url: string | string[];
}

// Schema definition
const showSchema = {
	type: "object",
	required: ["url"],
	properties: {
		url: {
			oneOf: [
				{ type: "string" },
				{ type: "array", items: { type: "string" } },
			],
			description: "URL or file path (or array of URLs/paths) to display. Content type is auto-detected from file extension.",
		},
	},
} as const;

/**
 * Auto-detect content type from file extension
 */
function detectContentType(url: string): ContentItem["type"] {
	const ext = extname(url).toLowerCase().slice(1);
	
	const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
	const codeExts = ["js", "ts", "jsx", "tsx", "py", "java", "cpp", "c", "go", "rs", "rb", "php", "cs", "swift", "kt"];
	
	if (imageExts.includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (ext === "html" || ext === "htm") return "html";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (codeExts.includes(ext)) return "code";
	if (ext === "svg") return "chart";
	
	return "file";
}

/**
 * Get MIME type from file extension
 */
function getMimeType(url: string): string | undefined {
	const ext = extname(url).toLowerCase().slice(1);
	
	const mimeTypes: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		pdf: "application/pdf",
		html: "text/html",
		htm: "text/html",
		md: "text/markdown",
		markdown: "text/markdown",
	};
	
	return mimeTypes[ext];
}

/**
 * Process a single URL/path
 */
function processUrl(url: string, cwd: string): ContentItem | { error: string } {
	// Resolve path
	const absolutePath = resolve(cwd, url);
	
	// Check if file exists
	if (!existsSync(absolutePath)) {
		return { error: `File not found: ${url}` };
	}
	
	// Get file stats
	const stats = statSync(absolutePath);
	if (!stats.isFile()) {
		return { error: `Not a file: ${url}` };
	}
	
	// Detect content type and MIME
	const contentType = detectContentType(absolutePath);
	const mimeType = getMimeType(absolutePath);
	
	return {
		type: contentType,
		url: absolutePath,
		filename: basename(absolutePath),
		mimeType,
	};
}

function getIconForType(type: string): string {
	const icons: Record<string, string> = {
		image: "📊",
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
 * Create show tool definition
 */
export function createShowToolDefinition(
	cwd: string,
	_options?: ShowToolOptions,
): ToolDefinition<typeof showSchema, ShowToolDetails> {
	return {
		name: "show",
		label: "show",
		description: "Display content (images, PDFs, HTML, Markdown, code, etc.) in a floating overlay. " +
			"Accepts a URL or file path, automatically detects content type from extension. " +
			"Supports showing multiple items at once - users can navigate between them in the overlay.",
		promptSnippet: "Display visual content",
		promptGuidelines: ["Use show to display images, PDFs, documents, code files, and other visual content."],
		parameters: showSchema,
		async execute(_toolCallId, params: Static<typeof showSchema>, _signal, _onUpdate, _ctx) {
			try {
				const input = params as ShowToolInput;
				const urls = Array.isArray(input.url) ? input.url : [input.url];
				
				if (urls.length === 0) {
					return {
						content: [{ type: "text", text: "No URLs provided" }],
						isError: true,
						details: { items: [] },
					};
				}
				
				// Process all URLs
				const items: ContentItem[] = [];
				const errors: string[] = [];
				
				for (const url of urls) {
					const result = processUrl(url, cwd);
					if ("error" in result) {
						errors.push(result.error);
					} else {
						items.push(result);
					}
				}
				
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: `Failed to process URLs: ${errors.join(", ")}` }],
						isError: true,
						details: { items: [] },
					};
				}
				
				const message = items.length === 1
					? `Content ready: ${items[0].filename}`
					: `${items.length} items ready`;
				
				return {
					content: [{ type: "text", text: message }],
					isError: false,
					details: { items },
					// Pass through the special marker for TUI
					__showContent: items,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
					details: { items: [] },
				};
			}
		},
		renderCall(args, _theme, context) {
			const renderArgs = args as { url?: string | string[] } | undefined;
			const urls = renderArgs?.url;
			const urlArray = Array.isArray(urls) ? urls : urls ? [urls] : [];
			
			let text = `${_theme.fg("toolTitle", _theme.bold("show"))}`;
			
			if (urlArray.length === 0) {
				text += ` ${_theme.fg("error", "[no URLs provided]")}`;
			} else if (urlArray.length === 1) {
				const url = urlArray[0];
				const urlStr = str(url);
				text += ` ${_theme.fg("text", urlStr || "")}`;
			} else {
				text += ` ${_theme.fg("text", `${urlArray.length} items`)}`;
			}
			
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(text);
			return component;
		},
		renderResult(result, _options, _theme, context) {
			// Check if result has __showContent marker
			const showContent = (result as any).__showContent as ContentItem[] | undefined;
			
			if (showContent && showContent.length > 0) {
				const container = (context.lastComponent as Container | undefined) ?? new Container();
				container.clear();
				
				// Render a list with numbers
				for (let i = 0; i < showContent.length; i++) {
					const item = showContent[i];
					const icon = getIconForType(item.type);
					const num = _theme.fg("dim", `[${i + 1}]`);
					const text = `${num} ${icon} ${item.filename}`;
					container.addChild(new Text(text, 0, 0));
				}
				
				// Add hint
				const hint = showContent.length === 1
					? _theme.fg("dim", "(Content ready to view)")
					: _theme.fg("dim", `(${showContent.length} items ready)`);
				container.addChild(new Text(hint, 0, 0));
				
				return container;
			}
			
			// Default: show error or success message
			const output = result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text || "")
				.join("\n");
				
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(context.isError ? _theme.fg("error", output) : output);
			return text;
		},
	};
}

/**
 * Create show tool
 */
export function createShowTool(cwd: string, options?: ShowToolOptions): AgentTool<typeof showSchema> {
	return wrapToolDefinition(createShowToolDefinition(cwd, options));
}
