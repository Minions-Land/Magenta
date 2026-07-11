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

	// When we have event snapshots, regenerate the per-event summaries at the
	// requested detail level. Collapsed by default (short chat), ctrl+o expands
	// to the full output. The instruction is carried explicitly in details.
	const eventData = message.details?.eventData;
	if (eventData && eventData.length > 0 && options.expanded !== undefined) {
		const instruction = message.details?.instruction ?? "";
		const summaries = eventData
			.map((event) => (options.expanded ? summarizeSubAgentExpanded(event) : summarizeSubAgentCollapsed(event)))
			.join("\n\n---\n\n");
		content = instruction ? `${instruction}\n\n${summaries}` : summaries;
	}

	box.addChild(
		new Markdown(content, 0, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("customMessageText", text),
		}),
	);

	return container;
}) satisfies MessageRenderer<SubAgentReturnDetails>;
