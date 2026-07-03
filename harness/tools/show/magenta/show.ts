/**
 * show tool - Magenta implementation
 * 
 * Displays content in a floating overlay. Accepts URL/path or array of URLs/paths.
 * Content type is auto-detected from file extension.
 */

import { existsSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

interface ShowInput {
	url: string | string[];
}

interface ContentItem {
	type: "image" | "pdf" | "html" | "markdown" | "code" | "chart" | "file";
	url: string;
	filename: string;
	mimeType?: string;
}

interface ToolContext {
	cwd: string;
}

interface ToolResult {
	success: boolean;
	message: string;
	[key: string]: any;
}

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

export default async function show(input: ShowInput, context: ToolContext): Promise<ToolResult> {
	const urls = Array.isArray(input.url) ? input.url : [input.url];
	
	if (urls.length === 0) {
		return {
			success: false,
			message: "No URLs provided",
		};
	}
	
	// Process all URLs
	const items: ContentItem[] = [];
	const errors: string[] = [];
	
	for (const url of urls) {
		const result = processUrl(url, context.cwd);
		if ("error" in result) {
			errors.push(result.error);
		} else {
			items.push(result);
		}
	}
	
	if (items.length === 0) {
		return {
			success: false,
			message: `Failed to process URLs: ${errors.join(", ")}`,
		};
	}
	
	// Return result with special marker for TUI
	const message = items.length === 1
		? `Content ready: ${items[0].filename}`
		: `${items.length} items ready`;
	
	return {
		success: true,
		message,
		items,
		// Special marker that tells TUI to render as clickable content
		__showContent: items,
	};
}
