import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

import { FLOATING_WINDOW_BODY_LINES, renderFloatingWindow } from "../shared/floating-window.ts";
import { formatDuration } from "../shared/shell.ts";
import type { JobEntry, JobFilter, NotifyLevel, TuiLike } from "./types.ts";

const VIEWPORT_LINES = FLOATING_WINDOW_BODY_LINES;
const COLLAPSED_TAIL_LINES = 2;
const EXPANDED_TAIL_LINES = 18;

function compactText(text: string, maxLength = 32): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function lastNonEmptyLines(text: string | undefined, maxLines: number): string[] {
	const lines = (text ?? "").trimEnd().split(/\r?\n/).filter((line) => line.trim().length > 0);
	return lines.slice(-maxLines);
}

function statusColor(theme: Theme, status: string): Parameters<typeof theme.fg>[0] {
	if (status === "running") return "accent";
	if (status === "exited") return "success";
	if (status === "cancelled") return "dim";
	return "warning";
}

function matchesAny(data: string, keys: string[]): boolean {
	return keys.some((key) => matchesKey(data, key));
}

export class JobsOverlay implements Component, Focusable {
	focused = false;
	private selectedIndex = 0;
	private scrollTop = 0;
	private expandedKeys = new Set<string>();
	private showHelp = false;

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly getFilter: () => JobFilter,
		private readonly setFilter: (filter: JobFilter) => void,
		private readonly getEntries: () => JobEntry[],
		private readonly sourceIds: () => string[],
		private readonly notify: (message: string, level?: NotifyLevel) => void,
		private readonly clearFailures: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesAny(data, ["escape", "ctrl+c"]) || data === "q") return this.done();
		if (data === "?") return this.toggleHelp();

		const entries = this.getEntries();
		this.syncSelection(entries);

		if (matchesAny(data, ["up"]) || data === "k") return this.moveSelection(-1, entries);
		if (matchesAny(data, ["down"]) || data === "j") return this.moveSelection(1, entries);
		if (matchesAny(data, ["pageUp", "ctrl+u"])) return this.moveSelection(-8, entries);
		if (matchesAny(data, ["pageDown", "ctrl+d"])) return this.moveSelection(8, entries);
		if (matchesAny(data, ["home"]) || data === "g") return this.selectIndex(0, entries);
		if (matchesAny(data, ["end"]) || data === "G") return this.selectIndex(Number.MAX_SAFE_INTEGER, entries);

		if (matchesAny(data, ["enter", "space"]) || data === "o") return this.toggleSelected(entries);
		if (data === "O") return this.toggleAllVisible(entries);
		if (data === "x") return this.cancelSelected(entries);
		if (data === "l") return this.showSelectedLog(entries);
		if (data === "c") return this.clearFailedWarnings();
		if (data === "R") return this.tui.requestRender();

		const nextFilter = this.filterForKey(data);
		if (nextFilter) return this.applyFilter(nextFilter);
	}

	render(width: number): string[] {
		const entries = this.getEntries();
		this.syncSelection(entries);

		const filter = this.getFilter();
		const range = entries.length > 0 ? `${Math.min(entries.length, this.selectedIndex + 1)}/${entries.length}` : "0/0";
		const bodyWidth = Math.max(20, width - 4);
		const body: string[] = [];

		if (this.showHelp) {
			body.push(...this.renderHelp());
		} else if (entries.length === 0) {
			body.push(this.theme.fg("dim", "no background jobs"));
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
			title: "jobs",
			subtitle: `${filter} · ${range}`,
			body,
			footer: this.showHelp ? "q/esc close · ? hide help" : "j/k move · o expand · x cancel · a/s/n/r/e/f filter · ? help · q close",
		});
	}

	invalidate(): void {
		// No cached render state.
	}

	private renderHelp(): string[] {
		return [
			this.theme.fg("accent", "keys"),
			"  j/k or ↑↓        move selection",
			"  ctrl+u/ctrl+d    page up/down",
			"  g/G              top/bottom",
			"  enter/space/o    expand current",
			"  O                expand/collapse visible",
			"  x                cancel selected running job",
			"  l                show selected log path",
			"  c                acknowledge failed footer warning",
			"  a/s/n/r/e/f      filters",
			"  R                refresh",
			"  q/esc            close",
		];
	}

	private renderEntry(entry: JobEntry, selected: boolean, width: number): string[] {
		const { source, job, key } = entry;
		const expanded = this.expandedKeys.has(key);
		const elapsedUntil = job.endedAt ?? Date.now();
		const elapsed = formatDuration(elapsedUntil - job.startedAt).padStart(6);
		const marker = selected ? this.theme.fg("accent", "›") : " ";
		const state = this.theme.fg(statusColor(this.theme, job.status), job.status.padEnd(9));
		const cancelHint = job.canCancel ? this.theme.fg("dim", " x") : "";
		const title = `${marker} ${state} ${source.id.padEnd(6)} ${job.id.padEnd(9)} ${this.theme.fg("dim", elapsed)} ${compactText(job.label, Math.max(24, width - 38))}${cancelHint}`;
		const lines = [title];

		if (expanded) {
			for (const detail of source.getJobDetails?.(job.id) ?? this.defaultJobDetails(entry)) {
				lines.push(this.theme.fg("dim", `  ${detail}`));
			}
			const tail = lastNonEmptyLines(job.tail, EXPANDED_TAIL_LINES);
			if (tail.length > 0) {
				lines.push(this.theme.fg("muted", "  output:"));
				for (const tailLine of tail) lines.push(this.theme.fg("dim", `  │ ${compactText(tailLine, Math.max(20, width - 6))}`));
			}
			return lines;
		}

		for (const tailLine of lastNonEmptyLines(job.tail, COLLAPSED_TAIL_LINES)) {
			lines.push(this.theme.fg("dim", `  │ ${compactText(tailLine, Math.max(20, width - 6))}`));
		}
		return lines;
	}

	private defaultJobDetails(entry: JobEntry): string[] {
		const details = [`id: ${entry.job.id}`, `source: ${entry.source.title}`];
		if (entry.job.cwd) details.push(`cwd: ${entry.job.cwd}`);
		if (entry.job.logPath) details.push(`log: ${entry.job.logPath}`);
		return details;
	}

	private syncSelection(entries: JobEntry[]): void {
		if (entries.length === 0) {
			this.selectedIndex = 0;
			this.scrollTop = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(entries.length - 1, this.selectedIndex));
		this.scrollTop = Math.max(0, Math.min(entries.length - 1, this.scrollTop));
	}

	private ensureSelectionVisible(entries: JobEntry[]): void {
		this.syncSelection(entries);
		if (entries.length === 0) return;
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		const maxVisibleEntries = 8;
		if (this.selectedIndex >= this.scrollTop + maxVisibleEntries) {
			this.scrollTop = Math.max(0, this.selectedIndex - maxVisibleEntries + 1);
		}
	}

	private moveSelection(delta: number, entries: JobEntry[]): void {
		this.selectIndex(this.selectedIndex + delta, entries);
	}

	private selectIndex(index: number, entries: JobEntry[]): void {
		if (entries.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(entries.length - 1, index));
		this.ensureSelectionVisible(entries);
		this.tui.requestRender();
	}

	private toggleSelected(entries: JobEntry[]): void {
		const entry = entries[this.selectedIndex];
		if (!entry) return;
		if (this.expandedKeys.has(entry.key)) this.expandedKeys.delete(entry.key);
		else this.expandedKeys.add(entry.key);
		this.tui.requestRender();
	}

	private toggleAllVisible(entries: JobEntry[]): void {
		if (entries.length === 0) return;
		const allExpanded = entries.every((entry) => this.expandedKeys.has(entry.key));
		for (const entry of entries) {
			if (allExpanded) this.expandedKeys.delete(entry.key);
			else this.expandedKeys.add(entry.key);
		}
		this.tui.requestRender();
	}

	private cancelSelected(entries: JobEntry[]): void {
		const entry = entries[this.selectedIndex];
		if (!entry) return;
		if (!entry.job.canCancel || !entry.source.cancelJob) {
			this.notify(`${entry.job.id} is not cancellable`, "warning");
			return;
		}
		const cancelled = entry.source.cancelJob(entry.job.id);
		this.notify(cancelled ? `Cancelled ${entry.job.id}` : `Could not cancel ${entry.job.id}`, cancelled ? "info" : "warning");
		this.tui.requestRender();
	}

	private showSelectedLog(entries: JobEntry[]): void {
		const entry = entries[this.selectedIndex];
		if (!entry) return;
		if (!entry.job.logPath) {
			this.notify(`${entry.job.id} has no log path`, "warning");
			return;
		}
		this.notify(entry.job.logPath, "info");
	}

	private clearFailedWarnings(): void {
		this.clearFailures();
		this.notify("Acknowledged failed background jobs", "info");
		this.tui.requestRender();
	}

	private toggleHelp(): void {
		this.showHelp = !this.showHelp;
		this.tui.requestRender();
	}

	private applyFilter(filter: JobFilter): void {
		this.setFilter(filter);
		this.selectedIndex = 0;
		this.scrollTop = 0;
		this.tui.requestRender();
	}

	private filterForKey(data: string): JobFilter | undefined {
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
