/**
 * Custom message renderer for bg-shell-return messages.
 * Supports collapsing long output with ctrl+o to expand.
 */

import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { summarizeEventCollapsed, summarizeEventExpanded } from "../../../core/tools/bg-shell.ts";
import type { Theme } from "../theme/theme.ts";

interface BgShellReturnDetails {
	id: string;
	status: string;
	exitCode: number | null;
	logPath: string;
	eventData?: any;
}

export const bgShellReturnRenderer: MessageRenderer<BgShellReturnDetails> = (
	message: CustomMessage<BgShellReturnDetails>,
	options,
	theme,
) => {
	const container = new Container();
	container.addChild(new Spacer(1));

	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	container.addChild(box);

	// Label
	const label = theme.fg("customMessageLabel", `\x1b[1m[bg-shell-return]\x1b[22m`);
	box.addChild(new Text(label, 0, 0));
	box.addChild(new Spacer(1));

	// Extract content
	let content: string;
	if (typeof message.content === "string") {
		content = message.content;
	} else {
		content = message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	// If we have event data and expanded state, regenerate with proper formatting
	const eventData = message.details?.eventData;
	if (eventData && options.expanded !== undefined) {
		// Split instruction from event summary
		const parts = content.split("\n\n");
		const instruction = parts[0] || "";
		const summary = options.expanded ? summarizeEventExpanded(eventData) : summarizeEventCollapsed(eventData);
		content = instruction ? `${instruction}\n\n${summary}` : summary;
	}

	// Render content as markdown
	box.addChild(
		new Markdown(content, 0, 0, undefined as any, {
			color: (text: string) => theme.fg("customMessageText", text),
		}),
	);

	return container;
};
