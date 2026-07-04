/**
 * show tool - Display content in floating overlay
 */

export interface ShowToolInput {
	url: string | string[];
}

export interface ContentItem {
	type: "image" | "pdf" | "html" | "markdown" | "code" | "chart" | "file";
	url: string;
	filename: string;
	mimeType?: string;
}

export interface ShowToolResult {
	success: boolean;
	message: string;
	items?: ContentItem[];
	__showContent?: ContentItem[];
}
