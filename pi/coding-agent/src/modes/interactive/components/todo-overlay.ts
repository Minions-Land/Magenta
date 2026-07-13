import type { TUI } from "@earendil-works/pi-tui";
import { type Component, type Focusable, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { flattenTodoPlan, type TodoNode, type TodoPlanState, type TodoStatus } from "@magenta/harness";
import type { Theme } from "../theme/theme.ts";
import { renderFloatingWindow } from "./floating-window.ts";

type Row = { node: TodoNode; depth: number; outline: string; hasChildren: boolean };

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
	private selectedIndex = 0;
	private scrollTop = 0;
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
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (data === "?") {
			this.showHelp = !this.showHelp;
			this.tui.requestRender();
			return;
		}
		if (data === "/") {
			this.searchMode = true;
			this.searchInput.focused = this._focused;
			this.tui.requestRender();
			return;
		}
		if (data === "f") {
			this.hideCompleted = !this.hideCompleted;
			this.selectedIndex = 0;
			this.scrollTop = 0;
			this.tui.requestRender();
			return;
		}

		const rows = this.rows();
		if (rows.length === 0) return;
		if (matchesKey(data, "up") || data === "k") this.move(-1, rows.length);
		else if (matchesKey(data, "down") || data === "j") this.move(1, rows.length);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.move(-8, rows.length);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.move(8, rows.length);
		else if (matchesKey(data, "home") || data === "g") this.selectedIndex = 0;
		else if (matchesKey(data, "end") || data === "G") this.selectedIndex = rows.length - 1;
		else if (matchesKey(data, "right") || data === "l") this.foldSelected(rows, false);
		else if (matchesKey(data, "left") || data === "h") this.foldSelected(rows, true);
		this.ensureVisible(rows.length);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const rows = this.rows();
		this.syncSelection(rows.length);
		const completed = this.state.nodes.filter((node) => node.status === "completed").length;
		const bodyWidth = Math.max(20, width - 4);
		let body: string[];
		if (this.showHelp) body = this.help();
		else if (rows.length === 0)
			body = [this.theme.fg("dim", this.state.nodes.length === 0 ? "No Todo plan" : "No matching Todo items")];
		else {
			this.ensureVisible(rows.length);
			body = rows
				.slice(this.scrollTop, this.scrollTop + this.viewportLines)
				.map((row, offset) => this.renderRow(row, this.scrollTop + offset === this.selectedIndex, bodyWidth));
		}
		while (body.length < this.viewportLines) body.push("");
		const query = this.searchInput.getValue().trim();
		return renderFloatingWindow({
			theme: this.theme,
			width,
			title: "Todo",
			subtitle: `${completed}/${this.state.nodes.length}${this.hideCompleted ? " · open" : ""}${query ? ` · /${query}` : ""}`,
			body,
			footer: this.searchMode
				? `search: ${this.searchInput.getValue()}  · enter/esc finish`
				: "j/k move · h/l fold · pgup/pgdn · / search · f completed · ? help · q close",
		});
	}

	invalidate(): void {}

	private rows(): Row[] {
		const byId = new Map(this.state.nodes.map((node) => [node.id, node]));
		const children = new Map<number | null, TodoNode[]>();
		for (const node of this.state.nodes) {
			const values = children.get(node.parentId) ?? [];
			values.push(node);
			children.set(node.parentId, values);
		}
		for (const values of children.values()) values.sort((a, b) => a.order - b.order || a.id - b.id);

		const query = this.searchInput.getValue().trim().toLowerCase();
		const outlines = new Map(flattenTodoPlan(this.state).map((row) => [row.node.id, row.outline]));
		const included = new Set<number>();
		for (const node of this.state.nodes) {
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

	private renderRow(row: Row, selected: boolean, width: number): string {
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
		const current = row.node.id === this.state.currentId ? this.theme.fg("accent", "  current") : "";
		return truncateToWidth(
			`${cursor} ${"  ".repeat(row.depth)}${fold} ${status} ${this.theme.fg("accent", row.outline)} ${text}${current}`,
			width,
			"",
		);
	}

	private move(delta: number, length: number): void {
		this.selectedIndex = Math.max(0, Math.min(length - 1, this.selectedIndex + delta));
	}
	private syncSelection(length: number): void {
		this.selectedIndex = length === 0 ? 0 : Math.max(0, Math.min(length - 1, this.selectedIndex));
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, length - 1)));
	}
	private ensureVisible(length: number): void {
		this.syncSelection(length);
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		if (this.selectedIndex >= this.scrollTop + this.viewportLines)
			this.scrollTop = this.selectedIndex - this.viewportLines + 1;
	}
	private foldSelected(rows: Row[], fold: boolean): void {
		const row = rows[this.selectedIndex];
		if (!row?.hasChildren) return;
		if (fold) this.folded.add(row.node.id);
		else this.folded.delete(row.node.id);
	}
	private help(): string[] {
		return [
			this.theme.fg("accent", "keys"),
			"  ↑↓ / j k          move selection",
			"  pgup/pgdn         page",
			"  home/end / g G    top/bottom",
			"  ←→ / h l          fold/unfold",
			"  /                 search text or #id",
			"  f                 hide/show completed",
			"  ?                 toggle help",
			"  q/esc             close",
		];
	}
}
