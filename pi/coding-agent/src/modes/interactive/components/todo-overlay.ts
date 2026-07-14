import type { TUI } from "@earendil-works/pi-tui";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	flattenTodoPlan,
	type TodoNode,
	type TodoPlanSnapshot,
	type TodoPlanState,
	type TodoStatus,
} from "@magenta/harness";
import type { Theme } from "../theme/theme.ts";
import { renderFloatingWindow } from "./floating-window.ts";

type Row = { node: TodoNode; depth: number; outline: string; hasChildren: boolean };
type View = "current" | "history" | "archive";
type HistoryEntry = { snapshot: TodoPlanSnapshot; index: number };

function statusSymbol(status: TodoStatus): string {
	if (status === "completed") return "✔";
	if (status === "in_progress") return "●";
	if (status === "blocked") return "!";
	return "□";
}

export class TodoOverlay implements Component, Focusable {
	private _focused = false;
	private readonly tui: Pick<TUI, "requestRender">;
	private readonly theme: Theme;
	private readonly state: TodoPlanState;
	private readonly done: () => void;
	private readonly viewportLines: number;
	private readonly folded = new Set<number>();
	private readonly searchInput = new Input();
	private view: View = "current";
	private archiveIndex: number | null = null;
	private selectedIndex = 0;
	private scrollTop = 0;
	private historySelectedIndex = 0;
	private historyScrollTop = 0;
	private hideCompleted = false;
	private searchMode = false;
	private showHelp = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.searchMode;
	}

	constructor(
		tui: Pick<TUI, "requestRender">,
		theme: Theme,
		state: TodoPlanState,
		terminalRows: number,
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.done = done;
		this.viewportLines = Math.max(8, Math.min(32, terminalRows - 8));
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
				this.searchMode = false;
				this.searchInput.focused = false;
			} else {
				this.searchInput.handleInput(data);
				this.selectedIndex = 0;
				this.scrollTop = 0;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.view === "archive") {
				this.view = "history";
				this.archiveIndex = null;
				this.resetPlanNavigation();
				this.tui.requestRender();
			} else {
				this.done();
			}
			return;
		}
		if (data === "?") {
			this.showHelp = !this.showHelp;
			this.tui.requestRender();
			return;
		}
		if (this.view !== "archive" && matchesKey(data, "tab")) {
			this.switchRootView(this.view === "current" ? "history" : "current");
			return;
		}
		if (this.view === "history") {
			this.handleHistoryInput(data);
			return;
		}
		if (data === "/") {
			this.searchMode = true;
			this.searchInput.focused = this._focused;
			this.tui.requestRender();
			return;
		}
		if (data === "f" && this.view === "current") {
			this.hideCompleted = !this.hideCompleted;
			this.selectedIndex = 0;
			this.scrollTop = 0;
			this.tui.requestRender();
			return;
		}

		const rows = this.rows(this.activePlan());
		if (rows.length === 0) return;
		if (matchesKey(data, "up") || data === "k") this.move(-1, rows.length);
		else if (matchesKey(data, "down") || data === "j") this.move(1, rows.length);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.move(-8, rows.length);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.move(8, rows.length);
		else if (matchesKey(data, "home") || data === "g") this.selectedIndex = 0;
		else if (matchesKey(data, "end") || data === "G") this.selectedIndex = rows.length - 1;
		else if (matchesKey(data, "right") || data === "l") this.foldSelected(rows, false);
		else if (matchesKey(data, "left") || data === "h") this.foldSelected(rows, true);
		this.ensureVisible(rows.length, this.planViewportLines());
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const bodyWidth = Math.max(20, width - 4);
		let body: string[];
		if (this.showHelp) body = this.help();
		else if (this.view === "history") body = this.renderHistory(bodyWidth);
		else body = this.renderPlan(bodyWidth);
		while (body.length < this.viewportLines) body.push("");
		body = body.slice(0, this.viewportLines);

		return renderFloatingWindow({
			theme: this.theme,
			width,
			title: "Todo",
			subtitle: this.subtitle(),
			body,
			footer: this.footer(),
		});
	}

	invalidate(): void {}

	private handleHistoryInput(data: string): void {
		const entries = this.historyEntries();
		if (entries.length === 0) return;
		if (matchesKey(data, "enter") || matchesKey(data, "right") || data === "l") {
			const entry = entries[this.historySelectedIndex];
			if (!entry) return;
			this.archiveIndex = entry.index;
			this.view = "archive";
			this.resetPlanNavigation();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.moveHistory(-1, entries.length);
		else if (matchesKey(data, "down") || data === "j") this.moveHistory(1, entries.length);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.moveHistory(-8, entries.length);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.moveHistory(8, entries.length);
		else if (matchesKey(data, "home") || data === "g") this.historySelectedIndex = 0;
		else if (matchesKey(data, "end") || data === "G") this.historySelectedIndex = entries.length - 1;
		else return;
		this.ensureHistoryVisible(entries.length, this.viewportLines - 1);
		this.tui.requestRender();
	}

	private switchRootView(view: "current" | "history"): void {
		this.view = view;
		this.archiveIndex = null;
		this.resetPlanNavigation();
		this.tui.requestRender();
	}

	private resetPlanNavigation(): void {
		this.folded.clear();
		this.searchInput.setValue("");
		this.searchMode = false;
		this.searchInput.focused = false;
		this.selectedIndex = 0;
		this.scrollTop = 0;
		this.hideCompleted = false;
		this.showHelp = false;
	}

	private activePlan(): TodoPlanSnapshot {
		if (this.view === "archive" && this.archiveIndex !== null) {
			return this.state.history[this.archiveIndex] ?? this.state;
		}
		return this.state;
	}

	private historyEntries(): HistoryEntry[] {
		return this.state.history.map((snapshot, index) => ({ snapshot, index })).reverse();
	}

	private renderTabs(active: "current" | "history"): string {
		const current = active === "current" ? this.theme.fg("accent", this.theme.bold("[Current]")) : "Current";
		const historyLabel = `History (${this.state.history.length})`;
		const history =
			active === "history" ? this.theme.fg("accent", this.theme.bold(`[${historyLabel}]`)) : historyLabel;
		return `${current}   ${history}`;
	}

	private renderHistory(width: number): string[] {
		const body = [this.renderTabs("history")];
		const entries = this.historyEntries();
		if (entries.length === 0) {
			body.push(this.theme.fg("dim", "No archived Todo plans"));
			return body;
		}
		const available = Math.max(1, this.viewportLines - body.length);
		this.ensureHistoryVisible(entries.length, available);
		for (let offset = 0; offset < available; offset++) {
			const rowIndex = this.historyScrollTop + offset;
			const entry = entries[rowIndex];
			if (!entry) break;
			const cursor = rowIndex === this.historySelectedIndex ? this.theme.fg("accent", "›") : " ";
			const number = this.theme.fg("accent", `#${entry.index + 1}`);
			const title = this.theme.fg("text", entry.snapshot.title);
			const count = this.theme.fg("dim", ` · ${entry.snapshot.nodes.length} items`);
			body.push(truncateToWidth(`${cursor} ${number} ${title}${count}`, width, ""));
		}
		return body;
	}

	private renderPlan(width: number): string[] {
		const plan = this.activePlan();
		const body = this.view === "current" ? [this.renderTabs("current")] : [];
		if (plan.summary) {
			const summaryLines = wrapTextWithAnsi(plan.summary, Math.max(10, width - 2)).slice(0, 3);
			for (let index = 0; index < summaryLines.length; index++) {
				body.push(this.theme.fg("muted", `${index === 0 ? "└ " : "  "}${summaryLines[index]}`));
			}
		}
		const rows = this.rows(plan);
		if (rows.length === 0) {
			body.push(
				this.theme.fg(
					"dim",
					plan.nodes.length === 0
						? this.view === "current"
							? "No current Todo plan"
							: "No archived Todo plan"
						: "No matching Todo items",
				),
			);
			return body;
		}
		const available = Math.max(1, this.viewportLines - body.length);
		this.ensureVisible(rows.length, available);
		body.push(
			...rows
				.slice(this.scrollTop, this.scrollTop + available)
				.map((row, offset) => this.renderRow(plan, row, this.scrollTop + offset === this.selectedIndex, width)),
		);
		return body;
	}

	private rows(plan: TodoPlanSnapshot): Row[] {
		const byId = new Map(plan.nodes.map((node) => [node.id, node]));
		const children = new Map<number | null, TodoNode[]>();
		for (const node of plan.nodes) {
			const values = children.get(node.parentId) ?? [];
			values.push(node);
			children.set(node.parentId, values);
		}
		for (const values of children.values()) values.sort((a, b) => a.order - b.order || a.id - b.id);

		const query = this.searchInput.getValue().trim().toLowerCase();
		const outlines = new Map(flattenTodoPlan(plan).map((row) => [row.node.id, row.outline]));
		const included = new Set<number>();
		for (const node of plan.nodes) {
			const statusMatch = !this.hideCompleted || node.status !== "completed";
			const queryMatch =
				!query ||
				node.text.toLowerCase().includes(query) ||
				String(node.id).includes(query.replace(/^#/, "")) ||
				outlines.get(node.id) === query;
			if (!statusMatch || !queryMatch) continue;
			let current: TodoNode | undefined = node;
			while (current) {
				included.add(current.id);
				current = current.parentId === null ? undefined : byId.get(current.parentId);
			}
		}

		const result: Row[] = [];
		const stack = (children.get(null) ?? [])
			.map((node, index) => ({ node, depth: 0, outline: String(index + 1) }))
			.reverse();
		while (stack.length > 0) {
			const row = stack.pop()!;
			if (!included.has(row.node.id)) continue;
			const descendants = children.get(row.node.id) ?? [];
			result.push({ node: row.node, depth: row.depth, outline: row.outline, hasChildren: descendants.length > 0 });
			if (!query && this.folded.has(row.node.id)) continue;
			for (let index = descendants.length - 1; index >= 0; index--)
				stack.push({
					node: descendants[index]!,
					depth: row.depth + 1,
					outline: `${row.outline}.${index + 1}`,
				});
		}
		return result;
	}

	private renderRow(plan: TodoPlanSnapshot, row: Row, selected: boolean, width: number): string {
		const cursor = selected ? this.theme.fg("accent", "›") : " ";
		const fold = row.hasChildren ? (this.folded.has(row.node.id) ? "▸" : "▾") : " ";
		const statusColor =
			row.node.status === "completed"
				? "success"
				: row.node.status === "blocked"
					? "warning"
					: row.node.status === "in_progress"
						? "accent"
						: "muted";
		const status = this.theme.fg(statusColor, statusSymbol(row.node.status));
		const text =
			row.node.status === "completed" ? this.theme.fg("dim", row.node.text) : this.theme.fg("text", row.node.text);
		const current = row.node.id === plan.currentId ? this.theme.fg("accent", "  current") : "";
		return truncateToWidth(
			`${cursor} ${"  ".repeat(row.depth)}${fold} ${status} ${this.theme.fg("accent", row.outline)} ${text}${current}`,
			width,
			"",
		);
	}

	private subtitle(): string {
		if (this.view === "history") return `history · ${this.state.history.length} archived`;
		const plan = this.activePlan();
		const completed = plan.nodes.filter((node) => node.status === "completed").length;
		if (this.view === "archive" && this.archiveIndex !== null) {
			return `history #${this.archiveIndex + 1}/${this.state.history.length} · ${plan.title} · ${completed}/${plan.nodes.length}`;
		}
		return `current · ${plan.title} · ${completed}/${plan.nodes.length} · ${this.state.history.length} archived`;
	}

	private footer(): string {
		if (this.searchMode) return `search: ${this.searchInput.getValue()}  · enter/esc finish`;
		if (this.showHelp)
			return this.view === "archive" ? "esc back · q close · ? hide help" : "q/esc close · ? hide help";
		if (this.view === "history") return "tab current · j/k move · enter open · ? help · q/esc close";
		if (this.view === "archive") return "j/k move · h/l fold · / search · ? help · esc back · q close";
		return "tab history · j/k move · h/l fold · / search · f completed · ? help · q/esc close";
	}

	private move(delta: number, length: number): void {
		this.selectedIndex = Math.max(0, Math.min(length - 1, this.selectedIndex + delta));
	}

	private syncSelection(length: number): void {
		this.selectedIndex = length === 0 ? 0 : Math.max(0, Math.min(length - 1, this.selectedIndex));
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, length - 1)));
	}

	private ensureVisible(length: number, visibleLines: number): void {
		this.syncSelection(length);
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		if (this.selectedIndex >= this.scrollTop + visibleLines) this.scrollTop = this.selectedIndex - visibleLines + 1;
	}

	private planViewportLines(): number {
		return Math.max(1, this.viewportLines - (this.view === "current" ? 1 : 0));
	}

	private moveHistory(delta: number, length: number): void {
		this.historySelectedIndex = Math.max(0, Math.min(length - 1, this.historySelectedIndex + delta));
	}

	private ensureHistoryVisible(length: number, visibleLines: number): void {
		this.historySelectedIndex = length === 0 ? 0 : Math.max(0, Math.min(length - 1, this.historySelectedIndex));
		this.historyScrollTop = Math.max(0, Math.min(this.historyScrollTop, Math.max(0, length - 1)));
		if (this.historySelectedIndex < this.historyScrollTop) this.historyScrollTop = this.historySelectedIndex;
		if (this.historySelectedIndex >= this.historyScrollTop + visibleLines)
			this.historyScrollTop = this.historySelectedIndex - visibleLines + 1;
	}

	private foldSelected(rows: Row[], fold: boolean): void {
		const row = rows[this.selectedIndex];
		if (!row?.hasChildren) return;
		if (fold) this.folded.add(row.node.id);
		else this.folded.delete(row.node.id);
	}

	private help(): string[] {
		if (this.view === "history") {
			return [
				this.theme.fg("accent", "keys"),
				"  tab               current plan",
				"  ↑↓ / j k          move selection",
				"  pgup/pgdn         page",
				"  home/end / g G    top/bottom",
				"  enter / → / l     open archived plan",
				"  ?                 toggle help",
				"  q/esc             close",
			];
		}
		return [
			this.theme.fg("accent", "keys"),
			...(this.view === "current" ? ["  tab               history"] : []),
			"  ↑↓ / j k          move selection",
			"  pgup/pgdn         page",
			"  home/end / g G    top/bottom",
			"  ←→ / h l          fold/unfold",
			"  /                 search text or #id",
			...(this.view === "current" ? ["  f                 hide/show completed"] : []),
			"  ?                 toggle help",
			this.view === "archive" ? "  esc               back to history" : "  q/esc             close",
			...(this.view === "archive" ? ["  q                 close"] : []),
		];
	}
}
