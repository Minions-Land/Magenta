import type { OverlayOptions } from "@earendil-works/pi-tui";
import {
	type Component,
	type Focusable,
	isKeyRelease,
	isKeyRepeat,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export const FLOATING_MENU_BODY_LINES = 20;

export const CENTER_FLOATING_MENU_OVERLAY: OverlayOptions = {
	anchor: "center",
	width: "72%",
	minWidth: 68,
	maxHeight: "82%",
	margin: 1,
};

export const COMMAND_DOCK_OVERLAY: OverlayOptions = {
	...CENTER_FLOATING_MENU_OVERLAY,
	nonCapturing: true,
};

const NAVIGATION_KEY_REPEAT_CADENCE_MS = 90;
const NAVIGATION_KEY_KITTY_HOLD_DELAY_MS = 500;
const NAVIGATION_KEY_HOLD_START_DELAY_MS = 180;
const NAVIGATION_KEY_HOLD_START_MAX_MS = 1200;
const NAVIGATION_KEY_UNMARKED_REPEAT_BURST_LIMIT = 12;

// Keys that trigger each navigation action, used to tell which navigation key a
// release event belongs to so hold tracking is only reset by the key that owns it.
const NAVIGATION_ACTION_KEYS: Record<string, KeyId[]> = {
	up: ["up"],
	down: ["down"],
	left: ["left"],
	right: ["right"],
	pageUp: ["pageUp", "ctrl+u"],
	pageDown: ["pageDown", "ctrl+d"],
	home: ["home"],
	end: ["end"],
};

export type FloatingMenuItem = {
	value: string;
	label: string;
	aliases?: string[];
	description?: string;
	active?: boolean;
	checked?: boolean;
	disabled?: boolean;
	children?: FloatingMenuItem[];
	keepOpen?: boolean;
	closeOnSelect?: boolean;
};

export type FloatingMenuBodyOptions = {
	title: string;
	subtitle?: string;
	items: FloatingMenuItem[];
	onSelect: (item: FloatingMenuItem) => undefined | boolean;
	emptyText?: string;
	requestRender: () => void;
	navigationRepeatDelayMs?: number;
	now?: () => number;
};

export type FloatingMenuRender = {
	title: string;
	subtitle?: string;
	body: string[];
	footer?: string | string[];
};

export type FloatingOverlayBody = {
	closeOnQ?: boolean;
	handleInput?: (data: string) => boolean | undefined;
	render: (width: number, height: number, focused: boolean) => FloatingMenuRender;
	invalidate?: () => void;
};

function matchesAny(data: string, keys: KeyId[]): boolean {
	return keys.some((key) => matchesKey(data, key));
}

function normalize(text: string | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function frameLine(content: string, width: number): string {
	const innerWidth = Math.max(1, width - 4);
	const line = padToWidth(truncateToWidth(content, innerWidth, ""), innerWidth);
	return `${theme.fg("borderMuted", "│ ")}${line}${theme.fg("borderMuted", " │")}`;
}

function horizontal(left: string, right: string, width: number, label = ""): string {
	const safeLabel = truncateToWidth(label, Math.max(0, width - 2), "");
	const available = Math.max(0, width - 2 - visibleWidth(safeLabel));
	return `${theme.fg("borderMuted", left)}${safeLabel}${theme.fg("borderMuted", "─".repeat(available))}${theme.fg(
		"borderMuted",
		right,
	)}`;
}

function renderFloatingFrame(options: {
	width: number;
	title: string;
	subtitle?: string;
	body: string[];
	footer?: string | string[];
}): string[] {
	const { width } = options;
	if (width < 8) return options.body.map((line) => truncateToWidth(line, width, ""));

	const title = ` ${theme.fg("accent", theme.bold(options.title))}${
		options.subtitle ? theme.fg("muted", ` · ${options.subtitle}`) : ""
	} `;
	const lines = [horizontal("╭", "╮", width, title)];

	for (const bodyLine of options.body) lines.push(frameLine(bodyLine, width));

	const footerLines = Array.isArray(options.footer) ? options.footer : options.footer ? [options.footer] : [];
	if (footerLines.length > 0) {
		lines.push(horizontal("├", "┤", width));
		for (const footerLine of footerLines) lines.push(frameLine(footerLine, width));
	}

	lines.push(horizontal("╰", "╯", width));
	return lines;
}

export class FloatingOverlayContainer implements Component, Focusable {
	focused = false;
	wantsKeyRelease = true;
	private readonly body: FloatingOverlayBody;
	private readonly done: () => void;

	constructor(body: FloatingOverlayBody, done: () => void) {
		this.body = body;
		this.done = done;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) {
			this.body.handleInput?.(data);
			return;
		}
		if (this.body.handleInput?.(data)) return;
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "left") ||
			matchesKey(data, "ctrl+c") ||
			(data === "q" && this.body.closeOnQ !== false)
		) {
			this.done();
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const rendered = this.body.render(innerWidth, FLOATING_MENU_BODY_LINES, this.focused);
		const body = rendered.body.slice(0, FLOATING_MENU_BODY_LINES);
		while (body.length < FLOATING_MENU_BODY_LINES) body.push("");
		return renderFloatingFrame({
			width,
			title: rendered.title,
			subtitle: rendered.subtitle,
			body,
			footer: rendered.footer,
		});
	}

	invalidate(): void {
		this.body.invalidate?.();
	}
}

export class FloatingMenuBody implements FloatingOverlayBody {
	private selectedIndex = 0;
	private scrollTop = 0;
	private filter = "";
	private lastNavigationKey: string | undefined = undefined;
	private lastNavigationEventAt = Number.NEGATIVE_INFINITY;
	private lastNavigationMoveAt = Number.NEGATIVE_INFINITY;
	private navigationRapidTapCount = 0;
	private navigationHeld = false;
	private firstNavigationPressAt = Number.NEGATIVE_INFINITY;
	private readonly options: FloatingMenuBodyOptions;
	private readonly stack: Array<{
		title: string;
		subtitle?: string;
		items: FloatingMenuItem[];
		selectedIndex: number;
		scrollTop: number;
	}> = [];

	constructor(options: FloatingMenuBodyOptions) {
		this.options = options;
		const activeIndex = options.items.findIndex((item) => item.active && !item.disabled);
		if (activeIndex >= 0) this.selectedIndex = activeIndex;
	}

	setFilter(filter: string): void {
		const next = normalize(filter).toLowerCase();
		if (this.filter === next) return;
		this.filter = next;
		this.selectedIndex = 0;
		this.scrollTop = 0;
		this.options.requestRender();
	}

	hasSelectableItems(): boolean {
		return this.current().items.some((item) => !item.disabled);
	}

	selectedItemHasChildren(): boolean {
		return Boolean(this.current().items[this.selectedIndex]?.children);
	}

	handleInput(data: string): boolean | undefined {
		if (isKeyRelease(data)) {
			if (this.releaseMatchesTrackedNavigation(data)) this.resetNavigationRepeat();
			return true;
		}
		// Navigation semantics (menu dock rules):
		//  - left  = go back one level; at the root it is a no-op (consumed) so
		//            the menu never closes on left. Only escape closes the root.
		//  - escape = go back one level; at the root it falls through (undefined)
		//            to let the container close the overlay.
		if (matchesKey(data, "left")) {
			if (this.shouldSuppressRepeatedNavigation("left", data)) return true;
			if (this.stack.length > 0) this.goBack();
			// At the root, swallow left so the overlay stays open.
			return true;
		}
		if (matchesKey(data, "escape")) {
			if (this.stack.length > 0) {
				this.goBack();
				return true;
			}
			return undefined;
		}
		if (matchesAny(data, ["up"])) return this.navigate("up", data, () => this.move(-1));
		if (matchesAny(data, ["down"])) return this.navigate("down", data, () => this.move(1));
		if (matchesAny(data, ["pageUp", "ctrl+u"])) return this.navigate("pageUp", data, () => this.move(-8));
		if (matchesAny(data, ["pageDown", "ctrl+d"])) return this.navigate("pageDown", data, () => this.move(8));
		if (matchesAny(data, ["home"])) return this.navigate("home", data, () => this.selectIndex(0));
		if (matchesAny(data, ["end"])) return this.navigate("end", data, () => this.selectIndex(Number.MAX_SAFE_INTEGER));
		if (matchesAny(data, ["right"])) return this.navigate("right", data, () => this.openCurrentChildOrHold());
		if (matchesAny(data, ["enter"])) return this.selectCurrent();
		// Swallow any other key so the overlay never closes on unmapped input.
		return undefined;
	}

	render(width: number, height: number): FloatingMenuRender {
		const current = this.current();
		return {
			title: current.title,
			subtitle: current.subtitle,
			body: this.renderBody(width, height),
			footer:
				this.stack.length > 0
					? "up/down move · right open · enter select · left/esc back"
					: "up/down move · right open · enter select · esc close",
		};
	}

	private renderBody(width: number, height: number): string[] {
		const items = this.current().items;
		if (items.length === 0) return [theme.fg("dim", this.options.emptyText ?? "no items")];

		this.syncSelection();
		this.ensureVisible(height);
		const lines: string[] = [];
		const end = Math.min(items.length, this.scrollTop + height);
		for (let index = this.scrollTop; index < end; index++) {
			const item = items[index]!;
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", ">") : " ";
			const marker = this.renderMarker(item);
			const labelRaw = normalize(item.label || item.value);
			const label = item.disabled ? theme.fg("dim", labelRaw) : selected ? theme.bold(labelRaw) : labelRaw;
			const left = `${prefix} ${marker} ${label}`;
			const descRaw = normalize(this.itemDescription(item));
			if (!descRaw || width < 46) {
				lines.push(truncateToWidth(left, width, ""));
				continue;
			}
			const leftWidth = visibleWidth(left);
			const descWidth = Math.max(8, width - leftWidth - 3);
			const gap = " ".repeat(Math.max(1, width - leftWidth - descWidth));
			lines.push(`${left}${theme.fg("muted", gap + truncateToWidth(descRaw, descWidth, ""))}`);
		}
		return lines;
	}

	private move(delta: number): true | undefined {
		const items = this.current().items;
		if (items.length === 0) return undefined;
		let next = this.selectedIndex;
		for (let attempts = 0; attempts < items.length; attempts++) {
			next = (next + delta + items.length) % items.length;
			if (!items[next]?.disabled) break;
		}
		this.selectedIndex = next;
		this.ensureVisible(20);
		this.options.requestRender();
		return true;
	}

	private navigate(action: string, data: string, fn: () => true | undefined): true | undefined {
		if (this.shouldSuppressRepeatedNavigation(action, data)) return true;
		return fn();
	}

	private shouldSuppressRepeatedNavigation(action: string, data: string): boolean {
		// Kitty terminals label repeats explicitly: a held key emits one press
		// followed by repeat events. Suppress every repeat so a held key moves once.
		if (isKeyRepeat(data)) {
			const now = this.options.now?.() ?? Date.now();
			if (this.lastNavigationKey !== action) {
				// Different key started repeating: reset the press timestamp.
				this.firstNavigationPressAt = now;
				this.navigationRapidTapCount = 0;
			}
			this.lastNavigationKey = action;
			this.lastNavigationEventAt = now;
			this.navigationHeld = true;

			const cadenceMs = this.options.navigationRepeatDelayMs ?? NAVIGATION_KEY_REPEAT_CADENCE_MS;
			const sincePressMs = now - this.firstNavigationPressAt;
			if (sincePressMs < NAVIGATION_KEY_KITTY_HOLD_DELAY_MS) {
				// Not held long enough yet: suppress the repeat.
				return true;
			}
			// Held long enough: allow repeat but throttle to the cadence.
			const shouldSuppress = now - this.lastNavigationMoveAt < cadenceMs;
			if (!shouldSuppress) this.lastNavigationMoveAt = now;
			return shouldSuppress;
		}

		const cadenceMs = this.options.navigationRepeatDelayMs ?? NAVIGATION_KEY_REPEAT_CADENCE_MS;
		if (cadenceMs <= 0) return false;

		const now = this.options.now?.() ?? Date.now();
		const isSameKey = this.lastNavigationKey === action;
		const sinceEvent = now - this.lastNavigationEventAt;
		const sinceMove = now - this.lastNavigationMoveAt;
		const holdStartDelayMs = Math.max(NAVIGATION_KEY_HOLD_START_DELAY_MS, cadenceMs * 2);
		const holdStartMaxMs = Math.max(NAVIGATION_KEY_HOLD_START_MAX_MS, holdStartDelayMs);
		let shouldSuppress = false;

		if (!isSameKey) {
			// A different navigation key: start fresh, always let it move.
			this.navigationRapidTapCount = 0;
			this.navigationHeld = false;
			this.firstNavigationPressAt = now;
		} else if (this.navigationHeld) {
			// Already recognized as a hold (no key metadata): throttle to one move
			// per cadence so the cursor scrolls steadily instead of freezing.
			shouldSuppress = sinceMove < cadenceMs;
		} else if (sinceEvent >= holdStartDelayMs && sinceEvent <= holdStartMaxMs) {
			// Steady same-key events at hold cadence: treat as a hold from now on,
			// but let this event move to keep scrolling responsive.
			this.navigationRapidTapCount = 0;
			this.navigationHeld = true;
		} else if (sinceEvent < cadenceMs) {
			// Rapid same-key events without metadata: allow a short burst of manual
			// taps, then throttle to the hold cadence rather than blocking outright.
			this.navigationRapidTapCount++;
			if (this.navigationRapidTapCount >= NAVIGATION_KEY_UNMARKED_REPEAT_BURST_LIMIT) {
				this.navigationHeld = true;
				shouldSuppress = sinceMove < cadenceMs;
			}
		} else {
			this.navigationRapidTapCount = 0;
			this.navigationHeld = false;
		}

		this.lastNavigationKey = action;
		this.lastNavigationEventAt = now;
		if (!shouldSuppress) this.lastNavigationMoveAt = now;
		return shouldSuppress;
	}

	private releaseMatchesTrackedNavigation(data: string): boolean {
		if (!this.lastNavigationKey) return false;
		const keys = NAVIGATION_ACTION_KEYS[this.lastNavigationKey];
		return keys?.some((key) => matchesKey(data, key)) ?? false;
	}

	private resetNavigationRepeat(): void {
		this.lastNavigationKey = undefined;
		this.lastNavigationEventAt = Number.NEGATIVE_INFINITY;
		this.lastNavigationMoveAt = Number.NEGATIVE_INFINITY;
		this.navigationRapidTapCount = 0;
		this.navigationHeld = false;
		this.firstNavigationPressAt = Number.NEGATIVE_INFINITY;
	}

	private selectIndex(index: number): true | undefined {
		const items = this.current().items;
		if (items.length === 0) return undefined;
		this.selectedIndex = Math.max(0, Math.min(items.length - 1, index));
		if (items[this.selectedIndex]?.disabled) this.move(index <= 0 ? 1 : -1);
		this.ensureVisible(20);
		this.options.requestRender();
		return true;
	}

	private selectCurrent(): true | undefined {
		const item = this.current().items[this.selectedIndex];
		if (!item || item.disabled) return undefined;
		if (item.children) {
			this.openChild(item);
			return true;
		}
		this.options.onSelect(item);
		return true;
	}

	private openCurrentChild(): true | undefined {
		const item = this.current().items[this.selectedIndex];
		if (!item || item.disabled || !item.children) return undefined;
		this.openChild(item);
		return true;
	}

	// Right-arrow variant: advance into a child when there is one, otherwise
	// hold (consume the key) at a leaf. Per the dock rules only enter confirms a
	// leaf, so right must not fall through and close the overlay.
	private openCurrentChildOrHold(): true | undefined {
		this.openCurrentChild();
		return true;
	}

	private syncSelection(): void {
		const items = this.current().items;
		if (items.length === 0) {
			this.selectedIndex = 0;
			this.scrollTop = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex));
		this.scrollTop = Math.max(0, Math.min(items.length - 1, this.scrollTop));
	}

	private ensureVisible(height: number): void {
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		if (this.selectedIndex >= this.scrollTop + height) {
			this.scrollTop = Math.max(0, this.selectedIndex - height + 1);
		}
	}

	private current(): { title: string; subtitle?: string; items: FloatingMenuItem[] } {
		const top = this.stack[this.stack.length - 1];
		if (top) return top;
		return { title: this.options.title, subtitle: this.options.subtitle, items: this.filteredRootItems() };
	}

	private filteredRootItems(): FloatingMenuItem[] {
		if (!this.filter) return this.options.items;
		return this.options.items
			.map((item, index) => ({ item, index, score: itemFilterScore(item, this.filter) }))
			.filter(({ score }) => score < Number.MAX_SAFE_INTEGER)
			.sort((left, right) => left.score - right.score || left.index - right.index)
			.map(({ item }) => item);
	}

	private openChild(item: FloatingMenuItem): void {
		this.stack.push({
			title: `${this.current().title} / ${item.label || item.value}`,
			subtitle: item.description ?? this.current().subtitle,
			items: item.children ?? [],
			selectedIndex: this.selectedIndex,
			scrollTop: this.scrollTop,
		});
		const activeIndex = (item.children ?? []).findIndex(
			(child) => (child.active || child.checked) && !child.disabled,
		);
		this.selectedIndex = activeIndex >= 0 ? activeIndex : 0;
		this.scrollTop = 0;
		this.options.requestRender();
	}

	private goBack(): void {
		const previous = this.stack.pop();
		this.selectedIndex = previous?.selectedIndex ?? 0;
		this.scrollTop = previous?.scrollTop ?? 0;
		this.options.requestRender();
	}

	private renderMarker(item: FloatingMenuItem): string {
		if (item.children) return theme.fg("muted", ">");
		if (item.checked) return theme.fg("accent", "x");
		if (item.active) return theme.fg("accent", "*");
		return " ";
	}

	private itemDescription(item: FloatingMenuItem): string | undefined {
		if (!item.children) return item.description;
		const active = firstActiveLeaf(item.children);
		if (active) return `current: ${active.label || active.value}`;
		const totals = leafTotals(item.children);
		if (totals.total > 0)
			return totals.checked > 0
				? `${totals.checked}/${totals.total} selected`
				: (item.description ?? `${totals.total} items`);
		return item.description;
	}
}

function firstActiveLeaf(items: FloatingMenuItem[]): FloatingMenuItem | undefined {
	for (const item of items) {
		if (item.active) return item;
		const child = item.children ? firstActiveLeaf(item.children) : undefined;
		if (child) return child;
	}
	return undefined;
}

function leafTotals(items: FloatingMenuItem[]): { checked: number; total: number } {
	let checked = 0;
	let total = 0;
	for (const item of items) {
		if (item.children) {
			const child = leafTotals(item.children);
			checked += child.checked;
			total += child.total;
			continue;
		}
		total++;
		if (item.checked) checked++;
	}
	return { checked, total };
}

function itemFilterScore(item: FloatingMenuItem, filter: string): number {
	const haystacks = [item.label, item.value, ...(item.aliases ?? [])].map((value) => normalize(value).toLowerCase());
	let best = Number.MAX_SAFE_INTEGER;
	for (const text of haystacks) {
		if (!text) continue;
		if (text === filter) best = Math.min(best, 0);
		else if (text.startsWith(filter)) best = Math.min(best, 1);
		else {
			const index = text.indexOf(filter);
			if (index >= 0) best = Math.min(best, 10 + index);
		}
	}
	if (item.children) {
		for (const child of item.children) {
			best = Math.min(best, 20 + itemFilterScore(child, filter));
		}
	}
	return best;
}
