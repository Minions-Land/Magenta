import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const FLOATING_WINDOW_BODY_LINES = 20;

export const CENTER_FLOATING_OVERLAY = {
	anchor: "center",
	width: "76%",
	minWidth: 72,
	maxHeight: "82%",
	margin: 1,
} as const;

type FloatingWindowOptions = {
	theme: Theme;
	width: number;
	title: string;
	subtitle?: string;
	body: string[];
	footer?: string | string[];
};

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function frameLine(theme: Theme, content: string, width: number): string {
	const innerWidth = Math.max(1, width - 4);
	const line = padToWidth(truncateToWidth(content, innerWidth, ""), innerWidth);
	return `${theme.fg("borderMuted", "│ ")}${line}${theme.fg("borderMuted", " │")}`;
}

function horizontal(theme: Theme, left: string, right: string, width: number, label = ""): string {
	const safeLabel = truncateToWidth(label, Math.max(0, width - 2), "");
	const available = Math.max(0, width - 2 - visibleWidth(safeLabel));
	return `${theme.fg("borderMuted", left)}${safeLabel}${theme.fg("borderMuted", "─".repeat(available))}${theme.fg("borderMuted", right)}`;
}

export function renderFloatingWindow(options: FloatingWindowOptions): string[] {
	const { theme, width } = options;
	if (width < 8) return options.body.map((line) => truncateToWidth(line, width, ""));

	const title = ` ${theme.fg("accent", theme.bold(options.title))}${options.subtitle ? theme.fg("dim", ` · ${options.subtitle}`) : ""} `;
	const lines = [horizontal(theme, "╭", "╮", width, title)];

	for (const bodyLine of options.body) lines.push(frameLine(theme, bodyLine, width));

	const footerLines = Array.isArray(options.footer) ? options.footer : options.footer ? [options.footer] : [];
	if (footerLines.length > 0) {
		lines.push(horizontal(theme, "├", "┤", width));
		for (const footerLine of footerLines) lines.push(frameLine(theme, footerLine, width));
	}

	lines.push(horizontal(theme, "╰", "╯", width));
	return lines;
}
