import { Text } from "@earendil-works/pi-tui";
import { formatDuration, truncateModelText } from "../background-shell-utils.ts";
import { type BackgroundShellEventSnapshot, summarizeEventExpanded } from "./bg-shell.ts";
import type { ToolRenderer } from "./renderer-registry.ts";

export type BgShellToolDetails = {
	action?: string;
	id?: string;
	status?: string;
	error?: string;
	eventData?: BackgroundShellEventSnapshot;
	eventsData?: BackgroundShellEventSnapshot[];
	[key: string]: unknown;
};

const SHORT_TAIL_BYTES = 180;
const SHORT_TAIL_LINES = 2;

function shortTail(tail: string | undefined): string[] {
	if (!tail?.trim()) return [];
	return tail
		.trimEnd()
		.split("\n")
		.slice(-SHORT_TAIL_LINES)
		.map((line) => truncateModelText(line, SHORT_TAIL_BYTES, "...").text);
}

function compactEvent(event: BackgroundShellEventSnapshot, action: string): string {
	const elapsed = formatDuration((event.endedAt ?? Date.now()) - event.startedAt);
	const lines = [`${action} ${event.id}: ${event.status} (${elapsed})`];
	if (event.error) lines.push(`Error: ${event.error}`);
	lines.push(...shortTail(event.tail));
	return lines.join("\n");
}

function expandedEvent(event: BackgroundShellEventSnapshot, action: string): string {
	try {
		return summarizeEventExpanded(event);
	} catch {
		return compactEvent(event, action);
	}
}

function compactLegacy(details: BgShellToolDetails | undefined): string {
	if (!details) return "bg_shell";
	const action = details.action ?? "bg_shell";
	if (details.id && details.status) return `${action} ${details.id}: ${details.status}`;
	if (details.status) return `${action}: ${details.status}`;
	return action;
}

function renderResultText(
	result: { content: any[]; details?: BgShellToolDetails },
	expanded: boolean,
	_context: { isError: boolean },
): string {
	const details = result.details;
	const action = details?.action ?? "bg_shell";
	if (expanded) {
		if (details?.eventData) return expandedEvent(details.eventData, action);
		if (details?.eventsData) {
			return details.eventsData.length
				? details.eventsData.map((event) => expandedEvent(event, action)).join("\n\n")
				: "No background events.";
		}
	}
	if (details?.eventData) return compactEvent(details.eventData, action);
	if (details?.eventsData) {
		if (details.eventsData.length === 0) return `${action}: no events`;
		return details.eventsData.map((event) => compactEvent(event, action)).join("\n");
	}
	// Legacy/native results may not carry eventData. Keep them compact and never
	// expose the model-facing payload as a raw fallback in the TUI or HTML.
	if (details?.error) return `${compactLegacy(details)}\nError: ${details.error}`;
	return compactLegacy(details);
}

export const bgShellRenderer: ToolRenderer<BgShellToolDetails> = {
	renderCall(args, theme, context) {
		const action = typeof args?.action === "string" ? args.action : "bg_shell";
		const suffix = typeof args?.eventId === "string" ? ` ${args.eventId}` : "";
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(theme.fg("toolTitle", theme.bold(`${action}${suffix}`)));
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const text = renderResultText(result, options.expanded, context);
		component.setText(theme.fg(context.isError ? "error" : "toolOutput", text));
		return component;
	},
};

// Kept exported for focused renderer tests and consumers that need the exact
// compact policy without constructing a TUI component.
export function summarizeBgShellCollapsed(event: BackgroundShellEventSnapshot, action = "bg_shell"): string {
	return compactEvent(event, action);
}
