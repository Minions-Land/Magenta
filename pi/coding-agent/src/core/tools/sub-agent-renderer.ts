/**
 * Custom TUI renderer for sub_agent tool results that supports collapsible output.
 * Shows header + tail when collapsed, full output when expanded (Ctrl+O).
 *
 * For action=start with multiple agents: displays using the existing tool-call-gallery.
 * For action=wait/status: displays collapsible detailed output.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { renderToolCallActivity, type ToolCallTile } from "../../modes/interactive/components/tool-call-gallery.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderer } from "./renderer-registry.ts";

// Number of lines to show at head and tail when collapsed
const COLLAPSED_HEAD_LINES = 5;
const COLLAPSED_TAIL_LINES = 5;

/**
 * Parse sub-agent output into structured sections.
 * Expected format from summarizeEvent:
 * - Header lines (Sub-agent:, Status:, Role:, etc.)
 * - Empty line
 * - "Output:" or "[Output truncated...]"
 * - Actual output content
 */
function parseSubAgentOutput(text: string): {
	header: string[];
	outputLabel: string;
	outputContent: string[];
} {
	const lines = text.split("\n");
	const outputIndex = lines.findIndex((line) => line.startsWith("Output:") || line.startsWith("[Output truncated"));

	if (outputIndex === -1) {
		// No output section found, treat everything as header
		return {
			header: lines,
			outputLabel: "",
			outputContent: [],
		};
	}

	const header = lines.slice(0, outputIndex).filter((line) => line.trim() !== "");
	const outputLabel = lines[outputIndex];
	const outputContent = lines.slice(outputIndex + 1);

	return { header, outputLabel, outputContent };
}

/**
 * Detect if this is a "Started N sub-agents" message (action=start with multiple agents).
 */
function parseMultiAgentStart(text: string): {
	isMultiStart: boolean;
	agents?: Array<{ id: string; status: string; label: string; logPath: string }>;
	footer?: string;
} {
	const lines = text.split("\n");
	const headerMatch = lines[0]?.match(/^Started (\d+) sub-agents? concurrently/);

	if (!headerMatch) {
		return { isMultiStart: false };
	}

	const agents: Array<{ id: string; status: string; label: string; logPath: string }> = [];
	let agentLineEnd = lines.length;

	// Parse agent lines (format: "agent_001\trunning\tlabel\tlogPath")
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.match(/^agent_\d+\t/)) {
			const parts = line.split("\t");
			if (parts.length >= 4) {
				agents.push({
					id: parts[0],
					status: parts[1],
					label: parts[2],
					logPath: parts[3],
				});
			}
		} else if (agents.length > 0) {
			agentLineEnd = i;
			break;
		}
	}

	const footer = lines.slice(agentLineEnd).join("\n").trim();

	return {
		isMultiStart: true,
		agents,
		footer,
	};
}

export const subAgentRenderer: ToolRenderer = {
	renderShell: "default",

	renderResult: (result, options, _themeArg, _context) => {
		const container = new Container();

		// Extract text content from result
		const textContent = result.content.find((c) => c.type === "text");
		if (!textContent?.text) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 1, 0));
			return container;
		}

		// Check if this is a multi-agent start message
		const multiStart = parseMultiAgentStart(textContent.text);
		if (multiStart.isMultiStart && multiStart.agents) {
			// Convert agents to ToolCallTile format for gallery rendering
			const tiles: ToolCallTile[] = multiStart.agents.map((agent, index) => ({
				id: agent.id,
				name: agent.id, // Use agent ID as the name so it shows in the tile
				args: { task: agent.label }, // Use label as task so it shows via summarizeToolCall
				status: agent.status === "running" ? "running" : "pending",
				output: undefined,
				sortIndex: index,
			}));

			// Render using the existing activity renderer (compact view)
			container.addChild({
				render: (width: number) => {
					const lines = renderToolCallActivity(tiles, width, {
						maxRows: 8,
						hint: undefined, // No hint needed for sub-agent starts
					});
					// Prepend a blank line and append footer
					const output = ["", ...lines];
					if (multiStart.footer) {
						output.push("");
						output.push(theme.fg("dim", multiStart.footer));
					}
					return output;
				},
				invalidate: () => {},
			});

			return container;
		}

		// Otherwise, render as detailed sub-agent output (wait/status results)
		const { header, outputLabel, outputContent } = parseSubAgentOutput(textContent.text);

		// Always show header info (status, role, cwd, etc.)
		if (header.length > 0) {
			const headerText = header.map((line) => theme.fg("muted", line)).join("\n");
			container.addChild(new Text(headerText, 1, 0));
		}

		// Show output section
		if (outputLabel || outputContent.length > 0) {
			container.addChild(new Spacer(1));

			if (outputLabel) {
				container.addChild(new Text(theme.fg("muted", outputLabel), 1, 0));
			}

			if (outputContent.length > 0) {
				if (options.expanded) {
					// Show all output lines
					const fullOutput = outputContent.map((line) => theme.fg("toolOutput", line)).join("\n");
					container.addChild(new Text(fullOutput, 1, 0));

					// Show collapse hint if output is substantial
					if (outputContent.length > COLLAPSED_HEAD_LINES + COLLAPSED_TAIL_LINES) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
								1,
								0,
							),
						);
					}
				} else {
					// Show head + tail with fold indicator
					const totalLines = outputContent.length;
					const shouldCollapse = totalLines > COLLAPSED_HEAD_LINES + COLLAPSED_TAIL_LINES + 2;

					if (shouldCollapse) {
						// Show head
						const headLines = outputContent.slice(0, COLLAPSED_HEAD_LINES);
						const headText = headLines.map((line) => theme.fg("toolOutput", line)).join("\n");
						container.addChild(new Text(headText, 1, 0));

						// Show fold indicator
						const hiddenCount = totalLines - COLLAPSED_HEAD_LINES - COLLAPSED_TAIL_LINES;
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `... ${hiddenCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
								1,
								0,
							),
						);

						// Show tail
						if (COLLAPSED_TAIL_LINES > 0) {
							container.addChild(new Spacer(1));
							const tailLines = outputContent.slice(-COLLAPSED_TAIL_LINES);
							const tailText = tailLines.map((line) => theme.fg("toolOutput", line)).join("\n");
							container.addChild(new Text(tailText, 1, 0));
						}
					} else {
						// Output is short enough, show everything
						const fullOutput = outputContent.map((line) => theme.fg("toolOutput", line)).join("\n");
						container.addChild(new Text(fullOutput, 1, 0));
					}
				}
			}
		}

		return container;
	},
};
