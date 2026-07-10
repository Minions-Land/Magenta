/**
 * Renderers for HCP web tools (web-search, web-fetch).
 * Parse the deterministic text output from Rust process tools and render
 * structured views with clickable links.
 */

import { Container, hyperlink, Text } from "@earendil-works/pi-tui";
import { getTextOutput } from "./render-utils.ts";
import type { ToolRenderer } from "./renderer-registry.ts";

/**
 * Renderer for the "search-results" data shape (WebSearch tool).
 * Parses the Rust tool's deterministic text output:
 *   Provider: <provider>
 *   Query: <query>
 *   ## <answer or instant result>
 *   ## Sources (N):
 *   [1] Title
 *       https://url
 *       snippet...
 */
export const searchResultsRenderer: ToolRenderer = {
	renderCall(args, _theme, context) {
		const query = (args as any)?.query;
		const text = `${_theme.fg("toolTitle", _theme.bold("WebSearch"))} ${_theme.fg("text", query || "[no query]")}`;
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(text);
		return component;
	},
	renderResult(result, _options, _theme, context) {
		const output = getTextOutput(result, context.showImages);
		if (!output) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText("");
			return component;
		}

		const lines = output.split("\n");
		const container = (context.lastComponent as Container | undefined) ?? new Container();
		container.clear();

		// Parse sections
		let provider = "";
		let query = "";
		const answerLines: string[] = [];
		const sourceBlocks: Array<{ title: string; url: string; snippet: string }> = [];
		let inSources = false;
		let currentSource: { title?: string; url?: string; snippet?: string } | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith("Provider:")) {
				provider = trimmed.replace(/^Provider:\s*/, "");
			} else if (trimmed.startsWith("Query:")) {
				query = trimmed.replace(/^Query:\s*/, "");
			} else if (trimmed.startsWith("## Sources")) {
				inSources = true;
			} else if (inSources) {
				// [N] Title
				const titleMatch = trimmed.match(/^\[(\d+)\]\s+(.+)$/);
				if (titleMatch) {
					if (currentSource?.title) {
						sourceBlocks.push({
							title: currentSource.title,
							url: currentSource.url || "",
							snippet: currentSource.snippet || "",
						});
					}
					currentSource = { title: titleMatch[2] };
				} else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
					if (currentSource) currentSource.url = trimmed;
				} else if (trimmed && currentSource) {
					currentSource.snippet = (currentSource.snippet || "") + (currentSource.snippet ? " " : "") + trimmed;
				}
			} else if (trimmed.startsWith("##") && !inSources) {
				answerLines.push(trimmed.replace(/^##\s*/, ""));
			} else if (trimmed && !inSources && provider) {
				answerLines.push(trimmed);
			}
		}
		// Flush last source
		if (currentSource?.title) {
			sourceBlocks.push({
				title: currentSource.title,
				url: currentSource.url || "",
				snippet: currentSource.snippet || "",
			});
		}

		// Render header
		if (provider || query) {
			let header = "";
			if (provider) header += _theme.fg("dim", `Provider: ${provider}`);
			if (query) header += (header ? " · " : "") + _theme.fg("dim", `Query: ${query}`);
			container.addChild(new Text(header, 0, 0));
		}

		// Render answer
		if (answerLines.length > 0) {
			container.addChild(new Text(_theme.fg("text", answerLines.join("\n")), 0, 0));
			container.addChild(new Text("", 0, 0)); // spacer
		}

		// Render sources
		if (sourceBlocks.length > 0) {
			container.addChild(new Text(_theme.fg("muted", `${sourceBlocks.length} source(s):`), 0, 0));
			for (let i = 0; i < sourceBlocks.length; i++) {
				const src = sourceBlocks[i];
				const num = _theme.fg("accent", `[${i + 1}]`);
				const title = _theme.fg("text", src.title);
				container.addChild(new Text(`${num} ${title}`, 0, 0));
				if (src.url) {
					const urlText = _theme.fg("mdLinkUrl", src.url);
					const linked = hyperlink(urlText, src.url);
					container.addChild(new Text(`    ${linked}`, 0, 0));
				}
				if (src.snippet) {
					const snippet = src.snippet.length > 200 ? `${src.snippet.slice(0, 200)}...` : src.snippet;
					container.addChild(new Text(_theme.fg("dim", `    ${snippet}`), 0, 0));
				}
			}
		}

		// Fallback if parsing failed
		if (container.children.length === 0) {
			container.addChild(new Text(_theme.fg("toolOutput", output), 0, 0));
		}

		return container;
	},
};

/**
 * Renderer for the "web-content" data shape (WebFetch tool).
 * Parses the Rust tool's output:
 *   URL: <url>
 *   Final-URL: <final>
 *   Status: <code>
 *   Content-Type: <type>
 *   Method: <method>
 *   Truncation: ...
 *   ---
 *   <content>
 */
export const webContentRenderer: ToolRenderer = {
	renderCall(args, _theme, context) {
		const url = (args as any)?.url;
		const text = `${_theme.fg("toolTitle", _theme.bold("WebFetch"))} ${_theme.fg("text", url || "[no URL]")}`;
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(text);
		return component;
	},
	renderResult(result, _options, _theme, context) {
		const output = getTextOutput(result, context.showImages);
		if (!output) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText("");
			return component;
		}

		const lines = output.split("\n");
		const container = (context.lastComponent as Container | undefined) ?? new Container();
		container.clear();

		// Parse header
		let url = "";
		let finalUrl = "";
		let status = "";
		let contentType = "";
		let method = "";
		let truncation = "";
		let contentStartIdx = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.startsWith("URL:")) {
				url = line.replace(/^URL:\s*/, "");
			} else if (line.startsWith("Final-URL:")) {
				finalUrl = line.replace(/^Final-URL:\s*/, "");
			} else if (line.startsWith("Status:")) {
				status = line.replace(/^Status:\s*/, "");
			} else if (line.startsWith("Content-Type:")) {
				contentType = line.replace(/^Content-Type:\s*/, "");
			} else if (line.startsWith("Method:")) {
				method = line.replace(/^Method:\s*/, "");
			} else if (line.startsWith("Truncation:")) {
				truncation = line.replace(/^Truncation:\s*/, "");
			} else if (line === "---") {
				contentStartIdx = i + 1;
				break;
			}
		}

		// Render header
		if (url) {
			const urlText = _theme.fg("mdLinkUrl", finalUrl || url);
			const linked = hyperlink(urlText, finalUrl || url);
			container.addChild(new Text(linked, 0, 0));
		}
		if (status || contentType) {
			const meta: string[] = [];
			if (status) meta.push(`Status: ${status}`);
			if (contentType) meta.push(`Type: ${contentType}`);
			if (method) meta.push(`Method: ${method}`);
			container.addChild(new Text(_theme.fg("dim", meta.join(" · ")), 0, 0));
		}
		if (truncation) {
			container.addChild(new Text(_theme.fg("warning", `[${truncation}]`), 0, 0));
		}

		// Render content
		if (contentStartIdx > 0 && contentStartIdx < lines.length) {
			const content = lines.slice(contentStartIdx).join("\n").trim();
			if (content) {
				container.addChild(new Text("", 0, 0)); // spacer
				container.addChild(new Text(_theme.fg("toolOutput", content), 0, 0));
			}
		}

		// Fallback if parsing failed
		if (container.children.length === 0) {
			container.addChild(new Text(_theme.fg("toolOutput", output), 0, 0));
		}

		return container;
	},
};
