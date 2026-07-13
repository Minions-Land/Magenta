import { EventsOverlay } from "../modes/interactive/components/events-overlay.ts";
import { CENTER_FLOATING_OVERLAY } from "../modes/interactive/components/floating-window.ts";
import { renderProgressBar, type ShellProgress } from "./background-shell-utils.ts";
import type { ExtensionContext } from "./extensions/types.ts";

const STATUS_KEY = "background-events";
const FAILED_STATUSES = new Set(["failed", "timed_out"]);
const DONE_STATUSES = new Set(["exited", "cancelled", "stopped"]);

export type EventStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled" | string;

export type MonitoredEvent = {
	id: string;
	status: EventStatus;
	startedAt: number;
	endedAt?: number;
	label: string;
	cwd?: string;
	logPath?: string;
	tail?: string;
	/** Optional progress reading (value + source) for a running event, when known. */
	progress?: ShellProgress;
	canCancel?: boolean;
};

export type EventSource = {
	id: string;
	title: string;
	getEvents: () => MonitoredEvent[];
	getEventDetails?: (id: string) => string[];
	cancelEvent?: (id: string, ctx?: ExtensionContext) => boolean;
};

export type EventFilter = "all" | "failed" | "running" | "exited" | string;

export type EventEntry = {
	source: EventSource;
	event: MonitoredEvent;
	key: string;
};

export type NotifyLevel = "info" | "warning" | "error";

export type TuiLike = {
	requestRender: () => void;
};

function eventKey(sourceId: string, eventId: string): string {
	return `${sourceId}:${eventId}`;
}

export class BackgroundEventManager {
	private sources = new Map<string, EventSource>();
	private acknowledgedFailures = new Set<string>();
	private statusCtx: ExtensionContext | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private overlayVisible = false;
	private overlayDone: (() => void) | undefined;
	private overlayTui: TuiLike | undefined;
	private filter: EventFilter = "all";

	registerSource(source: EventSource): { update: (ctx?: ExtensionContext) => void } {
		this.sources.set(source.id, source);
		return { update: (ctx) => this.update(ctx) };
	}

	update(ctx?: ExtensionContext): void {
		if (ctx?.hasUI) this.statusCtx = ctx;
		if (!this.statusCtx?.hasUI) return;

		const running = this.runningEvents();
		const failed = this.unacknowledgedFailures();
		const theme = this.statusCtx.ui.theme;

		if (running.length === 0 && failed.length === 0) {
			this.statusCtx.ui.setStatus(STATUS_KEY, undefined);
			this.updateOverlay();
			this.stopTimer();
			return;
		}

		const parts: string[] = [];
		if (running.length > 0) parts.push(`${running.length} running`);
		if (failed.length > 0) parts.push(`${failed.length} failed`);
		const icon = failed.length > 0 && running.length === 0 ? "⚠ " : running.length > 0 ? "● " : "⚠ ";
		const iconColor: Parameters<typeof theme.fg>[0] =
			failed.length > 0 && running.length === 0 ? "warning" : "accent";
		// When exactly one event is running and it reports progress, show its bar
		// inline. With multiple running events the bar is ambiguous, so fall back to
		// the aggregate count (per-event bars live in the /events overlay).
		const soleRunning = running.length === 1 && failed.length === 0 ? running[0]?.event : undefined;
		const progressSuffix = soleRunning?.progress ? ` ${renderProgressBar(soleRunning.progress)}` : "";
		this.statusCtx.ui.setStatus(
			STATUS_KEY,
			theme.fg(iconColor, icon) + theme.fg("dim", `bg: ${parts.join(", ")}${progressSuffix}`),
		);
		this.updateOverlay();

		if (running.length > 0 && !this.statusTimer) {
			this.statusTimer = setInterval(() => this.update(), 1000);
			this.statusTimer.unref?.();
		}
		if (running.length === 0) this.stopTimer();
	}

	async handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const action = args.trim().toLowerCase();

		if (action === "clear") {
			this.clearFailures();
			return;
		}
		if (action === "close" || action === "hide") {
			this.hide();
			return;
		}
		if (action === "open") {
			await this.show(ctx, "all");
			return;
		}
		if (["all", "failed", "running", "exited"].includes(action)) {
			await this.show(ctx, action as EventFilter);
			return;
		}
		if (this.sources.has(action)) {
			await this.show(ctx, action);
			return;
		}

		if (this.overlayVisible && this.filter === "all") this.hide();
		else await this.show(ctx, "all");
	}

	dispose(): void {
		this.statusCtx?.ui.setStatus(STATUS_KEY, undefined);
		this.hide();
		this.statusCtx = undefined;
		this.stopTimer();
	}

	private sourceEntries(): EventSource[] {
		return [...this.sources.values()];
	}

	private sourceEvents(source: EventSource): MonitoredEvent[] {
		return source.getEvents().sort((a, b) => b.startedAt - a.startedAt);
	}

	private allEntries(): EventEntry[] {
		return this.sourceEntries()
			.flatMap((source) =>
				this.sourceEvents(source).map((event) => ({ source, event, key: eventKey(source.id, event.id) })),
			)
			.sort((a, b) => b.event.startedAt - a.event.startedAt);
	}

	private runningEvents(): EventEntry[] {
		return this.allEntries().filter(({ event }) => event.status === "running");
	}

	private unacknowledgedFailures(): EventEntry[] {
		return this.allEntries().filter(
			({ key, event }) => FAILED_STATUSES.has(event.status) && !this.acknowledgedFailures.has(key),
		);
	}

	private visibleEntries(): EventEntry[] {
		const entries = this.allEntries();
		if (this.filter === "all") return entries;
		if (this.filter === "failed") return entries.filter(({ event }) => FAILED_STATUSES.has(event.status));
		if (this.filter === "running") return entries.filter(({ event }) => event.status === "running");
		if (this.filter === "exited") return entries.filter(({ event }) => DONE_STATUSES.has(event.status));
		return entries.filter(({ source }) => source.id === this.filter);
	}

	private updateOverlay(): void {
		if (!this.overlayVisible || !this.statusCtx?.hasUI) return;
		this.overlayTui?.requestRender();
	}

	private stopTimer(): void {
		if (!this.statusTimer) return;
		clearInterval(this.statusTimer);
		this.statusTimer = undefined;
	}

	private clearFailures(): void {
		for (const { key, event } of this.allEntries()) {
			if (FAILED_STATUSES.has(event.status)) this.acknowledgedFailures.add(key);
		}
		this.update();
	}

	private notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// UI may no longer be available.
		}
	}

	private async show(ctx: ExtensionContext, nextFilter: EventFilter = this.filter): Promise<void> {
		this.filter = nextFilter;
		this.statusCtx = ctx;
		this.update(ctx);

		if (this.overlayVisible) {
			this.updateOverlay();
			return;
		}

		this.overlayVisible = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					this.overlayTui = tui;
					this.overlayDone = done;
					return new EventsOverlay(
						tui,
						theme,
						done,
						() => this.filter,
						(next) => {
							this.filter = next;
						},
						() => this.visibleEntries(),
						() => [...this.sources.keys()],
						(message, level) => this.notify(ctx, message, level),
						() => this.clearFailures(),
					);
				},
				{
					overlay: true,
					onHandle: (handle) => handle.focus(),
					overlayOptions: CENTER_FLOATING_OVERLAY,
				},
			);
		} finally {
			this.overlayVisible = false;
			this.overlayDone = undefined;
			this.overlayTui = undefined;
		}
	}

	private hide(): void {
		this.overlayDone?.();
		this.overlayVisible = false;
		this.overlayTui = undefined;
		this.overlayDone = undefined;
	}
}
