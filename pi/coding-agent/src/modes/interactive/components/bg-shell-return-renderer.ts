/**
 * Custom message renderer for bg-shell-return messages.
 * Supports collapsing long output with ctrl+o to expand.
 */

import { Box, type Component, Container, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { type BackgroundShellEventSnapshot, summarizeEventExpanded } from "../../../core/tools/bg-shell.ts";

export interface BgShellReturnDetails {
	id: string;
	status: string;
	exitCode: number | null;
	logPath: string;
	instruction?: string;
	eventData?: BackgroundShellEventSnapshot;
}

const SECTION_HEADER = /^(?:Event|Status|Command|CWD|Elapsed|Progress|Exit code|Signal|Log|Error|Output):/;
const MAX_COLLAPSED_SECTION_LINES = 2;

/**
 * Split the return into independently collapsible fields. Background-shell
 * payloads are line-oriented, and continuation lines belong to the preceding
 * field (notably Command, Error, and Output).
 */
function splitSections(content: string): string[] {
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const firstHeader = lines.findIndex((line) => SECTION_HEADER.test(line));
	const sections: string[] = [];
	if (firstHeader > 0) {
		const preamble = lines.slice(0, firstHeader);
		while (preamble.at(-1) === "") preamble.pop();
		if (preamble.length > 0) sections.push(preamble.join("\n"));
	}
	const sectionLines = firstHeader >= 0 ? lines.slice(firstHeader) : lines;
	let current: string[] = [];

	for (const line of sectionLines) {
		const outputStarted = current[0]?.startsWith("Output:") === true;
		if (!outputStarted && SECTION_HEADER.test(line) && current.length > 0) {
			while (current.at(-1) === "") current.pop();
			if (current.length > 0) sections.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	while (current.at(-1) === "") current.pop();
	if (current.length > 0) sections.push(current.join("\n"));

	return sections.length > 0 ? sections : ["(no return details)"];
}

class SectionProjection implements Component {
	private readonly sections: string[];
	private readonly color: (text: string) => string;

	constructor(sections: string[], color: (text: string) => string) {
		this.sections = sections;
		this.color = color;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width);
		const lines: string[] = [];
		for (const section of this.sections) {
			const rendered = wrapTextWithAnsi(this.color(section), contentWidth);
			// A heading with no inline value (for example `Output:`) occupies its
			// own row and does not consume either of the two visible content rows.
			const headingRows = /^[^\n:]+:\s*(?:\n|$)/.test(section) ? 1 : 0;
			const visibleRows = MAX_COLLAPSED_SECTION_LINES + headingRows;
			if (rendered.length <= visibleRows) {
				lines.push(...rendered);
				continue;
			}

			lines.push(...rendered.slice(0, visibleRows));
			const hidden = rendered.length - visibleRows;
			lines.push(
				...wrapTextWithAnsi(
					this.color(`... ${hidden} ${hidden === 1 ? "line" : "lines"} hidden (ctrl+o to expand)`),
					contentWidth,
				),
			);
		}
		return lines;
	}

	invalidate(): void {}
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

	// eventData gives both views a stable user-facing projection without the
	// model-only instruction. Legacy messages fall back to their persisted payload.
	const eventData = message.details?.eventData;
	if (eventData) content = summarizeEventExpanded(eventData);

	if (options.expanded === true) {
		box.addChild(new Text(theme.fg("customMessageText", content), 0, 0));
	} else {
		box.addChild(new SectionProjection(splitSections(content), (text) => theme.fg("customMessageText", text)));
	}

	return container;
}) satisfies MessageRenderer<BgShellReturnDetails>;
