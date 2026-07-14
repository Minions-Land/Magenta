/**
 * Custom message renderer for sub-agent-return messages.
 * Collapses long sub-agent output by default; ctrl+o expands to the full tail.
 */

import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import {
	type SubAgentEventSnapshot,
	summarizeSubAgentCollapsed,
	summarizeSubAgentExpanded,
} from "../../../core/tools/sub-agent.ts";
import { getMarkdownTheme } from "../theme/theme.ts";

export interface SubAgentReturnDetails {
	ids: string[];
	statuses: string[];
	/** Instruction line stored separately for robust collapsed/expanded regeneration. */
	instruction?: string;
	/** Plain-data snapshots of the returned events, for collapsed/expanded regeneration. */
	eventData?: SubAgentEventSnapshot[];
}

export const subAgentReturnRenderer = ((message: CustomMessage<SubAgentReturnDetails>, options, theme) => {
	const container = new Container();
	container.addChild(new Spacer(1));

	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	container.addChild(box);

	const label = theme.fg("customMessageLabel", `\x1b[1m[sub-agent-return]\x1b[22m`);
	box.addChild(new Text(label, 0, 0));
	box.addChild(new Spacer(1));

	// Extract the content text (instruction + per-event summaries).
	let content: string;
	if (typeof message.content === "string") {
		content = message.content;
	} else {
		content = message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	// When we have event snapshots, render only the per-event summaries. The
	// model-facing instruction (details.instruction) is omitted from the TUI: it
	// steers the model and only adds chat noise for the user. Collapsed by default,
	// ctrl+o expands to full output.
	const eventData = message.details?.eventData;
	if (eventData && eventData.length > 0 && options.expanded !== undefined) {
		content = eventData
			.map((event) => (options.expanded ? summarizeSubAgentExpanded(event) : summarizeSubAgentCollapsed(event)))
			.join("\n\n---\n\n");
	} else if (!options.expanded && message.details?.ids?.length) {
		// Legacy messages without eventData: stay compact until expanded.
		const { ids, statuses } = message.details;
		content = ids.map((id, index) => `Sub-agent ${id}: ${statuses?.[index] ?? "done"} (ctrl+o to expand)`).join("\n");
	}

	box.addChild(
		new Markdown(content, 0, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("customMessageText", text),
		}),
	);

	return container;
}) satisfies MessageRenderer<SubAgentReturnDetails>;
