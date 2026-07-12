import { existsSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

export const showSchema = Type.Object({
	url: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"URL or file path to display. Parameter name is 'url' for both URLs and local file paths. Can be a single path/URL or an array.",
	}),
});

export type ShowToolInput = Static<typeof showSchema>;

export type ContentItem = {
	type: "image" | "pdf" | "html" | "markdown" | "code" | "chart" | "file";
	url: string;
	filename: string;
	mimeType?: string;
};

export type ShowToolDetails = {
	items: ContentItem[];
};

function detectContentType(value: string): ContentItem["type"] {
	const extension = extname(value).toLowerCase().slice(1);
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(extension)) return "image";
	if (extension === "pdf") return "pdf";
	if (extension === "html" || extension === "htm") return "html";
	if (extension === "md" || extension === "markdown") return "markdown";
	if (["js", "ts", "jsx", "tsx", "py", "java", "cpp", "c", "go", "rs", "rb", "php", "cs"].includes(extension)) {
		return "code";
	}
	return "file";
}

function mimeType(value: string): string | undefined {
	const extension = extname(value).toLowerCase().slice(1);
	return {
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
	}[extension];
}

function contentItem(value: string, cwd: string): ContentItem | { error: string } {
	if (/^https?:\/\//i.test(value)) {
		const url = new URL(value);
		const filename = basename(url.pathname) || url.hostname;
		return { type: detectContentType(url.pathname), url: value, filename, mimeType: mimeType(url.pathname) };
	}
	const path = resolve(cwd, value);
	if (!existsSync(path)) return { error: `File not found: ${value}` };
	if (!statSync(path).isFile()) return { error: `Not a file: ${value}` };
	return { type: detectContentType(path), url: path, filename: basename(path), mimeType: mimeType(path) };
}

export function createShowExecute(cwd: string) {
	return async function execute(_toolCallId: string, input: ShowToolInput): Promise<AgentToolResult<ShowToolDetails>> {
		const values = Array.isArray(input.url) ? input.url : [input.url];
		const items: ContentItem[] = [];
		const errors: string[] = [];
		for (const value of values) {
			const result = contentItem(value, cwd);
			if ("error" in result) errors.push(result.error);
			else items.push(result);
		}
		if (items.length === 0) {
			throw new Error(errors.length > 0 ? errors.join("\n") : "No URLs provided");
		}
		const message = items.length === 1 ? `Content ready: ${items[0]!.filename}` : `${items.length} items ready`;
		return { content: [{ type: "text", text: message }], details: { items } };
	};
}
