/**
 * Custom message renderer for bg-shell-return messages.
 * Supports collapsing long output with ctrl+o to expand.
 */

import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import {
	type BackgroundShellEventSnapshot,
	summarizeEventCollapsed,
	summarizeEventExpanded,
} from "../../../core/tools/bg-shell.ts";
import { getMarkdownTheme } from "../theme/theme.ts";

export interface BgShellReturnDetails {
	id: string;
	status: string;
	exitCode: number | null;
	logPath: string;
	instruction?: string;
	eventData?: BackgroundShellEventSnapshot;
}

export const bgShellReturnRenderer = ((message: CustomMessage<BgShellReturnDetails>, options, theme) => {
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

	// When we have event data, render only the compact event summary. The
	// model-facing instruction (details.instruction) is intentionally omitted from
	// the TUI: it exists to steer the model, not to inform the user. Collapsed mode
	// stays a single status line plus an output hint; expanded reveals metadata and
	// the captured output tail.
	const eventData = message.details?.eventData;
	if (eventData && options.expanded !== undefined) {
		content = options.expanded ? summarizeEventExpanded(eventData) : summarizeEventCollapsed(eventData);
	} else if (!options.expanded && message.details) {
		// Legacy messages without eventData: stay compact until expanded instead of
		// dumping the full raw payload into the collapsed chat view.
		const { id, status } = message.details;
		if (id && status) content = `Background job ${id}: ${status} (ctrl+o to expand)`;
	}

	// Render content as markdown
	box.addChild(
		new Markdown(content, 0, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("customMessageText", text),
		}),
	);

	return container;
}) satisfies MessageRenderer<BgShellReturnDetails>;
