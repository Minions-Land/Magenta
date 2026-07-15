import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import {
	backgroundEventStallKinds,
	type EventEntry,
	type EventFilter,
	type EventUiTelemetry,
	type NotifyLevel,
	type TuiLike,
} from "../../../core/background-events.ts";
import { formatDuration, renderProgressBar } from "../../../core/background-shell-utils.ts";
import type { Theme } from "../theme/theme.ts";
import { FLOATING_WINDOW_BODY_LINES, renderFloatingWindow } from "./floating-window.ts";

const VIEWPORT_LINES = FLOATING_WINDOW_BODY_LINES;
const COLLAPSED_TAIL_LINES = 2;
const EXPANDED_TAIL_LINES = 18;

function compactText(text: string, maxLength = 32): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function lastNonEmptyLines(text: string | undefined, maxLines: number): string[] {
	const lines = (text ?? "")
		.trimEnd()
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	return lines.slice(-maxLines);
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function knownNonNegative(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

export function formatEventUiTelemetry(telemetry: EventUiTelemetry | undefined): string {
	if (!telemetry) return "";
	const parts: string[] = [];
	if (knownNonNegative(telemetry.input) && telemetry.input > 0) parts.push(`↑${formatTokens(telemetry.input)}`);
	if (knownNonNegative(telemetry.output) && telemetry.output > 0) parts.push(`↓${formatTokens(telemetry.output)}`);
	if (knownNonNegative(telemetry.cacheRead) && telemetry.cacheRead > 0) {
		parts.push(`R${formatTokens(telemetry.cacheRead)}`);
	}
	if (knownNonNegative(telemetry.cacheWrite) && telemetry.cacheWrite > 0) {
		parts.push(`W${formatTokens(telemetry.cacheWrite)}`);
	}
	if (
		knownNonNegative(telemetry.input) &&
		knownNonNegative(telemetry.cacheRead) &&
		knownNonNegative(telemetry.cacheWrite)
	) {
		const promptTokens = telemetry.input + telemetry.cacheRead + telemetry.cacheWrite;
		if ((telemetry.cacheRead > 0 || telemetry.cacheWrite > 0) && promptTokens > 0) {
			parts.push(`CH${((telemetry.cacheRead / promptTokens) * 100).toFixed(1)}%`);
		}
	}
	if (telemetry.costUnknown) parts.push("cost?");
	else if (knownNonNegative(telemetry.cost) && telemetry.cost > 0) parts.push(`$${telemetry.cost.toFixed(3)}`);

	const contextUsage = telemetry.contextUsage;
	if (contextUsage && knownNonNegative(contextUsage.contextWindow)) {
		const percent =
			contextUsage.percent === null || !knownNonNegative(contextUsage.percent)
				? "?"
				: `${contextUsage.percent.toFixed(1)}%`;
		parts.push(
			`${percent}/${formatTokens(contextUsage.contextWindow)}${telemetry.autoCompactEnabled ? " (auto)" : ""}`,
		);
	}
	if (knownNonNegative(telemetry.assistantMessages)) {
		parts.push(`${telemetry.assistantMessages} msg${telemetry.assistantMessages === 1 ? "" : "s"}`);
	}
	return parts.join(" ");
}

type ThemeColor = Parameters<Theme["fg"]>[0];

function statusColor(status: string): ThemeColor {
	if (status === "running") return "accent";
	if (status === "exited") return "success";
	if (status === "cancelled") return "dim";
	return "warning";
}

function matchesAny(data: string, keys: string[]): boolean {
	return keys.some((key) => matchesKey(data, key as any));
}

export class EventsOverlay implements Component, Focusable {
	focused = false;
	selectedIndex = 0;
	scrollTop = 0;
	expandedKeys = new Set<string>();
	showHelp = false;
	tui: TuiLike;
	theme: Theme;
	done: () => void;
	getFilter: () => EventFilter;
	setFilter: (filter: EventFilter) => void;
	getEntries: () => EventEntry[];
	sourceIds: () => string[];
	notify: (message: string, level?: NotifyLevel) => void;
	clearFailures: () => void;

	constructor(
		tui: TuiLike,
		theme: Theme,
		done: () => void,
		getFilter: () => EventFilter,
		setFilter: (filter: EventFilter) => void,
		getEntries: () => EventEntry[],
		sourceIds: () => string[],
		notify: (message: string, level?: NotifyLevel) => void,
		clearFailures: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.getFilter = getFilter;
		this.setFilter = setFilter;
		this.getEntries = getEntries;
		this.sourceIds = sourceIds;
		this.notify = notify;
		this.clearFailures = clearFailures;
	}

	handleInput(data: string): void {
		if (matchesAny(data, ["escape", "ctrl+c"]) || data === "q") {
			this.done();
			return;
		}
		if (data === "?") {
			this.toggleHelp();
			return;
		}

		const entries = this.getEntries();
		this.syncSelection(entries);

		if (matchesAny(data, ["up"]) || data === "k") {
			this.moveSelection(-1, entries);
			return;
		}
		if (matchesAny(data, ["down"]) || data === "j") {
			this.moveSelection(1, entries);
			return;
		}
		if (matchesAny(data, ["pageUp", "ctrl+u"])) {
			this.moveSelection(-8, entries);
			return;
		}
		if (matchesAny(data, ["pageDown", "ctrl+d"])) {
			this.moveSelection(8, entries);
			return;
		}
		if (matchesAny(data, ["home"]) || data === "g") {
			this.selectIndex(0, entries);
			return;
		}
		if (matchesAny(data, ["end"]) || data === "G") {
			this.selectIndex(Number.MAX_SAFE_INTEGER, entries);
			return;
		}

		if (matchesAny(data, ["enter", "space"]) || data === "o") {
			this.toggleSelected(entries);
			return;
		}
		if (data === "O") {
			this.toggleAllVisible(entries);
			return;
		}
		if (data === "x") {
			this.cancelSelected(entries);
			return;
		}
		if (data === "l") {
			this.showSelectedLog(entries);
			return;
		}
		if (data === "c") {
			this.clearFailedWarnings();
			return;
		}
		if (data === "R") {
			this.tui.requestRender();
			return;
		}

		const nextFilter = this.filterForKey(data);
		if (nextFilter) {
			this.applyFilter(nextFilter);
			return;
		}
	}

	render(width: number): string[] {
		const entries = this.getEntries();
		this.syncSelection(entries);

		const filter = this.getFilter();
		const range =
			entries.length > 0 ? `${Math.min(entries.length, this.selectedIndex + 1)}/${entries.length}` : "0/0";
		const bodyWidth = Math.max(20, width - 4);
		const body: string[] = [];

		if (this.showHelp) {
			body.push(...this.renderHelp());
		} else if (entries.length === 0) {
			body.push(this.theme.fg("dim", "no background events"));
		} else {
			this.ensureSelectionVisible(entries);
			let cursor = this.scrollTop;
			while (cursor < entries.length && body.length < VIEWPORT_LINES) {
				const entry = entries[cursor]!;
				for (const rendered of this.renderEntry(entry, cursor === this.selectedIndex, bodyWidth)) {
					if (body.length >= VIEWPORT_LINES) break;
					body.push(rendered);
				}
				cursor++;
			}
		}

		while (body.length < VIEWPORT_LINES) body.push("");

		return renderFloatingWindow({
			theme: this.theme,
			width,
			title: "events",
			subtitle: `${filter} · ${range}`,
			body,
			footer: this.showHelp
				? "q/esc close · ? hide help"
				: "j/k move · o expand · x cancel · a/s/n/r/e/f filter · ? help · q close",
		});
	}

	invalidate(): void {
		// No cached render state.
	}

	renderHelp(): string[] {
		return [
			this.theme.fg("accent", "keys"),
			"  j/k or ↑↓        move selection",
			"  ctrl+u/ctrl+d    page up/down",
			"  g/G              top/bottom",
			"  enter/space/o    expand current",
			"  O                expand/collapse visible",
			"  x                cancel selected running event",
			"  l                show selected log path",
			"  c                acknowledge failed footer warning",
			"  a/s/n/r/e/f      filters",
			"  R                refresh",
			"  q/esc            close",
		];
	}

	renderEntry(entry: EventEntry, selected: boolean, width: number): string[] {
		const { source, event, key } = entry;
		const expanded = this.expandedKeys.has(key);
		const elapsedUntil = event.endedAt ?? Date.now();
		const elapsed = formatDuration(elapsedUntil - event.startedAt).padStart(6);
		const marker = selected ? this.theme.fg("accent", "›") : " ";
		const stallKinds = backgroundEventStallKinds(event);
		const statusLabel = stallKinds.length > 0 ? stallKinds.join("/") : event.status;
		const state = this.theme.fg(stallKinds.length > 0 ? "warning" : statusColor(event.status), statusLabel.padEnd(9));
		const cancelHint = event.canCancel ? this.theme.fg("dim", " x") : "";
		const title = `${marker} ${state} ${source.id.padEnd(6)} ${event.id.padEnd(9)} ${this.theme.fg("dim", elapsed)} ${compactText(event.label, Math.max(24, width - 38))}${cancelHint}`;
		const lines = [title];

		// Per-event progress bar for running events that report progress. The
		// status bar shows a bar only for a sole running event; the overlay shows
		// one per event so multiple concurrent tasks each get their own.
		if (event.status === "running" && event.progress) {
			lines.push(this.theme.fg("accent", `  ${renderProgressBar(event.progress)}`));
		}

		const telemetry = formatEventUiTelemetry(source.getUiTelemetry?.(event.id, () => this.tui.requestRender()));
		if (telemetry) lines.push(this.theme.fg("dim", `  ${telemetry}`));

		if (expanded) {
			if (event.activityPhase) lines.push(this.theme.fg("dim", `  phase: ${event.activityPhase}`));
			for (const detail of source.getEventDetails?.(event.id) ?? this.defaultEventDetails(entry)) {
				lines.push(this.theme.fg("dim", `  ${detail}`));
			}
			const tail = lastNonEmptyLines(event.tail, EXPANDED_TAIL_LINES);
			if (tail.length > 0) {
				lines.push(this.theme.fg("muted", "  output:"));
				for (const tailLine of tail)
					lines.push(this.theme.fg("dim", `  │ ${compactText(tailLine, Math.max(20, width - 6))}`));
			}
			return lines;
		}

		for (const tailLine of lastNonEmptyLines(event.tail, COLLAPSED_TAIL_LINES)) {
			lines.push(this.theme.fg("dim", `  │ ${compactText(tailLine, Math.max(20, width - 6))}`));
		}
		return lines;
	}

	defaultEventDetails(entry: EventEntry): string[] {
		const details = [`id: ${entry.event.id}`, `source: ${entry.source.title}`];
		if (entry.event.cwd) details.push(`cwd: ${entry.event.cwd}`);
		if (entry.event.logPath) details.push(`log: ${entry.event.logPath}`);
		return details;
	}

	syncSelection(entries: EventEntry[]): void {
		if (entries.length === 0) {
			this.selectedIndex = 0;
			this.scrollTop = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(entries.length - 1, this.selectedIndex));
		this.scrollTop = Math.max(0, Math.min(entries.length - 1, this.scrollTop));
	}

	ensureSelectionVisible(entries: EventEntry[]): void {
		this.syncSelection(entries);
		if (entries.length === 0) return;
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		const maxVisibleEntries = 8;
		if (this.selectedIndex >= this.scrollTop + maxVisibleEntries) {
			this.scrollTop = Math.max(0, this.selectedIndex - maxVisibleEntries + 1);
		}
	}

	moveSelection(delta: number, entries: EventEntry[]): void {
		this.selectIndex(this.selectedIndex + delta, entries);
	}

	selectIndex(index: number, entries: EventEntry[]): void {
		if (entries.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(entries.length - 1, index));
		this.ensureSelectionVisible(entries);
		this.tui.requestRender();
	}

	toggleSelected(entries: EventEntry[]): void {
		const entry = entries[this.selectedIndex];
		if (!entry) return;
		if (this.expandedKeys.has(entry.key)) this.expandedKeys.delete(entry.key);
		else this.expandedKeys.add(entry.key);
		this.tui.requestRender();
	}

	toggleAllVisible(entries: EventEntry[]): void {
		if (entries.length === 0) return;
		const allExpanded = entries.every((entry) => this.expandedKeys.has(entry.key));
		for (const entry of entries) {
			if (allExpanded) this.expandedKeys.delete(entry.key);
			else this.expandedKeys.add(entry.key);
		}
		this.tui.requestRender();
	}

	cancelSelected(entries: EventEntry[]): void {
		const entry = entries[this.selectedIndex];
		if (!entry) return;
		if (!entry.event.canCancel || !entry.source.cancelEvent) {
			this.notify(`${entry.event.id} is not cancellable`, "warning");
			return;
		}
		const cancelled = entry.source.cancelEvent(entry.event.id);
		this.notify(
			cancelled ? `Cancelled ${entry.event.id}` : `Could not cancel ${entry.event.id}`,
			cancelled ? "info" : "warning",
		);
		this.tui.requestRender();
	}

	showSelectedLog(entries: EventEntry[]): void {
		const entry = entries[this.selectedIndex];
		if (!entry) return;
		if (!entry.event.logPath) {
			this.notify(`${entry.event.id} has no log path`, "warning");
			return;
		}
		this.notify(entry.event.logPath, "info");
	}

	clearFailedWarnings(): void {
		this.clearFailures();
		this.notify("Acknowledged failed background events", "info");
		this.tui.requestRender();
	}

	toggleHelp(): void {
		this.showHelp = !this.showHelp;
		this.tui.requestRender();
	}

	applyFilter(filter: EventFilter): void {
		this.setFilter(filter);
		this.selectedIndex = 0;
		this.scrollTop = 0;
		this.tui.requestRender();
	}

	filterForKey(data: string): EventFilter | undefined {
		const sourceIds = this.sourceIds();
		if (data === "a") return "all";
		if (data === "f") return "failed";
		if (data === "r") return "running";
		if (data === "e") return "exited";
		if (data === "s" && sourceIds.includes("shell")) return "shell";
		if (data === "n" && sourceIds.includes("agents")) return "agents";
		return undefined;
	}
}
