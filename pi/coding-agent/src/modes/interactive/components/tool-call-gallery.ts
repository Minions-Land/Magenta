import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	conciseToolErrorSummary,
	resolveDisplayToolName,
	summarizeToolCall,
} from "../../../core/tools/tool-display.ts";
import { theme } from "../theme/theme.ts";

export type ToolTileStatus = "pending" | "running" | "success" | "error";

export interface ToolCallTile {
	id: string;
	name: string;
	args?: unknown;
	status: ToolTileStatus;
	output?: string;
	sortIndex: number;
}

export interface ToolGalleryConfig {
	maxHeight: number;
	minCellInnerWidth: number;
	minCellHeight: number;
	preferredCellHeight: number;
	gap: number;
	targetAspect: number;
}

interface GridShape {
	cols: number;
	rows: number;
	shown: number;
}

const DEFAULT_CONFIG: ToolGalleryConfig = {
	maxHeight: 14,
	minCellInnerWidth: 18,
	minCellHeight: 4,
	preferredCellHeight: 7,
	gap: 2,
	targetAspect: 4.5,
};

function statusColor(status: ToolTileStatus): (text: string) => string {
	switch (status) {
		case "running":
			return (text) => theme.fg("warning", text);
		case "success":
			return (text) => theme.fg("success", text);
		case "error":
			return (text) => theme.fg("error", text);
		default:
			return (text) => theme.fg("muted", text);
	}
}

function markerFor(status: ToolTileStatus): string {
	switch (status) {
		case "running":
			return ">";
		case "success":
			return "+";
		case "error":
			return "!";
		default:
			return "-";
	}
}

function chooseGrid(tileCount: number, totalWidth: number, cfg: ToolGalleryConfig): GridShape | undefined {
	if (tileCount <= 0 || totalWidth <= 0 || cfg.maxHeight <= 0) return undefined;
	const minCellTotal = cfg.minCellInnerWidth + 2;
	const maxColsByWidth = Math.max(
		1,
		Math.min(tileCount, Math.floor((totalWidth + cfg.gap) / (minCellTotal + cfg.gap))),
	);
	const maxRowsByHeight = Math.max(1, Math.floor(cfg.maxHeight / cfg.minCellHeight));
	const maxVisibleCells = Math.max(1, maxColsByWidth * maxRowsByHeight);
	let best: { cost: number; shape: GridShape } | undefined;
	for (let cols = 1; cols <= maxColsByWidth; cols++) {
		const cellWidth = Math.floor((totalWidth - (cols - 1) * cfg.gap) / cols);
		if (cellWidth < minCellTotal) continue;
		const rowsNeeded = Math.ceil(tileCount / cols);
		const rows = Math.max(1, Math.min(rowsNeeded, maxRowsByHeight));
		const shown = Math.min(tileCount, cols * rows, maxVisibleCells);
		const cellHeight = Math.floor((cfg.maxHeight - (rows - 1) * cfg.gap) / rows);
		if (cellHeight <= 0) continue;
		const aspect = cellWidth / cellHeight;
		const emptySlots = Math.max(0, cols * rows - shown);
		const cost = Math.abs(aspect - cfg.targetAspect) + emptySlots * 0.6 - shown * 0.01;
		if (!best || cost < best.cost) {
			best = { cost, shape: { cols, rows, shown } };
		}
	}
	return best?.shape;
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function frameContentLine(text: string, innerWidth: number): string {
	const content = padToWidth(truncateToWidth(text, innerWidth, "."), innerWidth);
	return `${theme.fg("borderMuted", "|")}${theme.fg("toolOutput", content)}${theme.fg("borderMuted", "|")}`;
}

function outputLines(tile: ToolCallTile): string[] {
	const output = tile.output?.trim();
	if (!output) return [];
	const error = conciseToolErrorSummary(output);
	if (error) return [error];
	return output.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function tileBody(tile: ToolCallTile): string[] {
	const summary = summarizeToolCall({ name: tile.name, args: tile.args }, 52);
	const lines = summary ? [summary] : [];
	lines.push(...outputLines(tile));
	return lines;
}

function wrapTail(lines: string[], width: number, height: number): string[] {
	if (width <= 0 || height <= 0) return [];
	let rows: string[] = [];
	for (let index = lines.length - 1; index >= 0; index--) {
		const wrapped = wrapTextWithAnsi(lines[index]!, width);
		rows = [...wrapped, ...rows];
		if (rows.length >= height) break;
	}
	return rows.slice(Math.max(0, rows.length - height));
}

function renderCell(tile: ToolCallTile, innerWidth: number, innerHeight: number): string[] {
	const color = statusColor(tile.status);
	const title = `${markerFor(tile.status)} ${resolveDisplayToolName(tile.name)}`;
	const badge = `[${tile.status}]`;
	const titleBudget = Math.max(1, innerWidth - visibleWidth(badge) - 3);
	const titleText = color(truncateToWidth(title, titleBudget, "."));
	const titleVisible = visibleWidth(truncateToWidth(title, titleBudget, "."));
	const dashCount = Math.max(1, innerWidth - titleVisible - visibleWidth(badge) - 1);
	const top = `${theme.fg("borderMuted", "+-")}${titleText}${theme.fg("borderMuted", "-".repeat(dashCount))}${color(badge)}${theme.fg("borderMuted", "+")}`;
	const body = wrapTail(tileBody(tile), innerWidth, innerHeight);
	const blankTop = Math.max(0, innerHeight - body.length);
	const out = [top];
	for (let i = 0; i < blankTop; i++) out.push(frameContentLine("", innerWidth));
	for (const line of body) out.push(frameContentLine(line, innerWidth));
	out.push(theme.fg("borderMuted", `+${"-".repeat(innerWidth)}+`));
	return out;
}

function sortTiles(tiles: ToolCallTile[]): ToolCallTile[] {
	const statusRank: Record<ToolTileStatus, number> = { running: 0, pending: 1, error: 2, success: 3 };
	return [...tiles].sort(
		(a, b) => statusRank[a.status] - statusRank[b.status] || a.sortIndex - b.sortIndex || a.id.localeCompare(b.id),
	);
}

export function renderToolCallStrip(tiles: ToolCallTile[], width: number): string[] {
	if (tiles.length === 0 || width <= 0) return [];
	const ordered = sortTiles(tiles);
	const active = ordered.filter((tile) => tile.status === "running" || tile.status === "pending").length;
	const tally = `${active}/${ordered.length} active`;
	const prefix = theme.fg("toolTitle", "tools ");
	const suffix = statusColor(active > 0 ? "running" : "success")(tally);
	const suffixWidth = visibleWidth(tally);
	const budget = Math.max(0, width - visibleWidth("tools ") - suffixWidth - 2);
	const chips: string[] = [];
	let used = 0;
	let shown = 0;
	for (const tile of ordered) {
		const text = `${markerFor(tile.status)}${resolveDisplayToolName(tile.name)}`;
		const chip = statusColor(tile.status)(text);
		const chipWidth = visibleWidth(text);
		const sep = shown === 0 ? 0 : 1;
		if (used + sep + chipWidth > budget && shown > 0) break;
		if (shown > 0) {
			chips.push(" ");
			used += 1;
		}
		chips.push(chip);
		used += chipWidth;
		shown += 1;
	}
	const hidden = ordered.length - shown;
	if (hidden > 0) {
		const more = ` +${hidden}`;
		chips.push(theme.fg("muted", more));
		used += visibleWidth(more);
	}
	const pad = Math.max(1, width - visibleWidth("tools ") - used - suffixWidth);
	return [truncateToWidth(`${prefix}${chips.join("")}${" ".repeat(pad)}${suffix}`, width, "")];
}

export function renderToolCallGallery(
	tiles: ToolCallTile[],
	width: number,
	config: Partial<ToolGalleryConfig> = {},
): string[] {
	if (tiles.length === 0 || width < 8) return [];
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const ordered = sortTiles(tiles);
	const active = ordered.filter((tile) => tile.status === "running" || tile.status === "pending").length;
	const header = `${theme.fg("toolTitle", "tools")} ${theme.fg("muted", `- ${ordered.length} call${ordered.length === 1 ? "" : "s"}`)}${
		active > 0 ? theme.fg("warning", ` - ${active} active`) : ""
	}`;
	const shape = chooseGrid(ordered.length, width, cfg);
	if (!shape) return [truncateToWidth(header, width, "")];
	const cellTotalWidth = Math.floor((width - (shape.cols - 1) * cfg.gap) / shape.cols);
	const cellInnerWidth = Math.max(1, cellTotalWidth - 2);
	const cellTotalHeight = Math.max(
		cfg.minCellHeight,
		Math.min(cfg.preferredCellHeight, Math.floor(cfg.maxHeight / shape.rows)),
	);
	const cellInnerHeight = Math.max(1, cellTotalHeight - 2);
	const visibleTiles = ordered.slice(0, shape.shown);
	const out = [truncateToWidth(header, width, "")];
	for (let row = 0; row < shape.rows; row++) {
		const rowTiles = visibleTiles.slice(row * shape.cols, row * shape.cols + shape.cols);
		if (rowTiles.length === 0) break;
		const blocks = rowTiles.map((tile) => renderCell(tile, cellInnerWidth, cellInnerHeight));
		for (let lineIndex = 0; lineIndex < cellTotalHeight; lineIndex++) {
			out.push(blocks.map((block) => block[lineIndex] ?? " ".repeat(cellTotalWidth)).join(" ".repeat(cfg.gap)));
		}
	}
	const hidden = ordered.length - shape.shown;
	if (hidden > 0) out.push(theme.fg("muted", `  +${hidden} more call${hidden === 1 ? "" : "s"}`));
	return out;
}
