import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	type ContentItem,
	createShowExecute,
	type ShowToolDetails,
	type ShowToolInput,
	showSchema,
} from "@magenta/harness";
import type { ToolDefinition } from "../extensions/types.ts";
import { str } from "./render-utils.ts";
import type { ToolRenderer } from "./renderer-registry.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export type { ContentItem, ShowToolDetails, ShowToolInput };
export type ShowToolOptions = Record<string, never>;

function iconForType(type: string): string {
	return (
		{
			image: "[image]",
			pdf: "[pdf]",
			html: "[html]",
			markdown: "[markdown]",
			code: "[code]",
			chart: "[chart]",
			file: "[file]",
		}[type] ?? "[file]"
	);
}

export const showRenderer: ToolRenderer<ShowToolDetails> = {
	renderCall(args, theme, context) {
		const urls = (args as { url?: string | string[] } | undefined)?.url;
		const values = Array.isArray(urls) ? urls : urls ? [urls] : [];
		const suffix =
			values.length === 1 ? (str(values[0]) ?? "") : values.length > 1 ? `${values.length} items` : "[no URL]";
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(`${theme.fg("toolTitle", theme.bold("show"))} ${theme.fg("text", suffix)}`);
		return component;
	},
	renderResult(result, _options, theme, context) {
		const items = result.details?.items ?? [];
		if (items.length > 0) {
			const container = (context.lastComponent as Container | undefined) ?? new Container();
			container.clear();
			for (const [index, item] of items.entries()) {
				container.addChild(
					new Text(`${theme.fg("dim", `[${index + 1}]`)} ${iconForType(item.type)} ${item.filename}`, 0, 0),
				);
			}
			return container;
		}
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(context.isError ? theme.fg("error", output) : output);
		return component;
	},
};

export function createShowToolDefinition(
	cwd: string,
	_options?: ShowToolOptions,
): ToolDefinition<typeof showSchema, ShowToolDetails> {
	return {
		name: "show",
		label: "show",
		description: "Display local files or remote URLs in the host preview surface.",
		promptSnippet: "Display visual content",
		promptGuidelines: ["Use show to display images, PDFs, documents, code files, and remote visual content."],
		parameters: showSchema,
		renderKind: "file-preview",
		execute: createShowExecute(cwd),
	};
}

export function createShowTool(cwd: string, options?: ShowToolOptions): AgentTool<typeof showSchema> {
	return wrapToolDefinition(createShowToolDefinition(cwd, options));
}
