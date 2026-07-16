import { EventsOverlay } from "../modes/interactive/components/events-overlay.ts";
import { CENTER_FLOATING_OVERLAY } from "../modes/interactive/components/floating-window.ts";
import { renderProgressBar, type ShellProgress } from "./background-shell-utils.ts";
import type { ExtensionContext } from "./extensions/types.ts";

const STATUS_KEY = "background-events";
const FAILED_STATUSES = new Set(["failed", "timed_out"]);
const DONE_STATUSES = new Set(["exited", "cancelled", "stopped"]);

export type EventStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled" | string;

export type BackgroundReminderThresholds = {
	expectedMultiplier: number;
	expectedGraceMs: number;
	expectedMinimumMs: number;
	silentMs: number;
};

export const DEFAULT_BACKGROUND_REMINDER_THRESHOLDS: BackgroundReminderThresholds = {
	expectedMultiplier: 1.5,
	expectedGraceMs: 30_000,
	expectedMinimumMs: 60_000,
	silentMs: 5 * 60_000,
};

export type BackgroundStallKind = "overdue" | "silent";

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
	/** Expected wall-clock duration. Used for overdue detection, not as real activity. */
	expectedSeconds?: number;
	/** Most recent real output, progress, phase, or transport activity. */
	lastActivityAt?: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	activityPhase?: string;
	/** Sources opt in so legacy running sources are never reminded unexpectedly. */
	reminderEligible?: boolean;
	canCancel?: boolean;
};

export function backgroundEventDeadlines(
	event: MonitoredEvent,
	thresholds: BackgroundReminderThresholds = DEFAULT_BACKGROUND_REMINDER_THRESHOLDS,
): { overdueAt?: number; silentAt?: number } {
	if (event.status !== "running" || event.reminderEligible !== true) return {};
	const expectedMs =
		typeof event.expectedSeconds === "number" && Number.isFinite(event.expectedSeconds) && event.expectedSeconds > 0
			? event.expectedSeconds * 1000
			: undefined;
	return {
		overdueAt:
			expectedMs === undefined
				? undefined
				: event.startedAt +
					Math.max(
						expectedMs * thresholds.expectedMultiplier,
						expectedMs + thresholds.expectedGraceMs,
						thresholds.expectedMinimumMs,
					),
		silentAt: (event.lastActivityAt ?? event.startedAt) + thresholds.silentMs,
	};
}

export function backgroundEventStallKinds(
	event: MonitoredEvent,
	now = Date.now(),
	thresholds: BackgroundReminderThresholds = DEFAULT_BACKGROUND_REMINDER_THRESHOLDS,
): BackgroundStallKind[] {
	const deadlines = backgroundEventDeadlines(event, thresholds);
	const kinds: BackgroundStallKind[] = [];
	if (deadlines.overdueAt !== undefined && now >= deadlines.overdueAt) kinds.push("overdue");
	if (deadlines.silentAt !== undefined && now >= deadlines.silentAt) kinds.push("silent");
	return kinds;
}

export type EventUiTelemetry = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	costUnknown?: boolean;
	contextUsage?: {
		percent: number | null;
		contextWindow: number;
	};
	autoCompactEnabled?: boolean;
	assistantMessages?: number;
};

export type EventSource = {
	id: string;
	title: string;
	getEvents: () => MonitoredEvent[];
	getEventDetails?: (id: string) => string[];
	/** UI-only, on-demand telemetry. It must never be copied into MonitoredEvent or headless snapshots. */
	getUiTelemetry?: (id: string, onUpdate: () => void) => EventUiTelemetry | undefined;
	cancelEvent?: (id: string, ctx?: ExtensionContext) => boolean;
};

export type EventFilter = "all" | "failed" | "running" | "exited" | string;

export type EventEntry = {
	source: EventSource;
	event: MonitoredEvent;
	key: string;
};

/** Plain-data event view for headless protocols and SDK callers. */
export type BackgroundEventSnapshot = MonitoredEvent & {
	sourceId: string;
	sourceTitle: string;
};

export type NotifyLevel = "info" | "warning" | "error";

export type TuiLike = {
	requestRender: () => void;
};

function eventKey(sourceId: string, eventId: string): string {
	return `${sourceId}:${eventId}`;
}

function isActiveStatus(status: string): boolean {
	return status === "running" || status === "terminating";
}

export class BackgroundEventManager {
	private sources = new Map<string, EventSource>();
	private acknowledgedFailures = new Set<string>();
	private changeListeners = new Set<(disposed: boolean) => void>();
	private statusCtx: ExtensionContext | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private overlayVisible = false;
	private overlayDone: (() => void) | undefined;
	private overlayTui: TuiLike | undefined;
	private filter: EventFilter = "all";
	private disposed = false;

	registerSource(source: EventSource): { update: (ctx?: ExtensionContext) => void; dispose: () => void } {
		if (this.disposed) return { update: () => {}, dispose: () => {} };
		this.sources.set(source.id, source);
		this.emitChange(false);
		return {
			update: (ctx) => this.update(ctx),
			dispose: () => {
				if (this.sources.get(source.id) !== source) return;
				this.sources.delete(source.id);
				this.update();
			},
		};
	}

	/** Subscribe to source updates without exposing the manager's listener set. */
	subscribeChanges(listener: (disposed: boolean) => void): () => void {
		if (this.disposed) {
			try {
				listener(true);
			} catch {
				// Match normal notification behavior: one observer cannot disrupt cleanup.
			}
			return () => {};
		}
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	update(ctx?: ExtensionContext, emitChange = true): void {
		if (this.disposed) return;
		if (emitChange) this.emitChange(false);
		if (ctx?.hasUI) this.statusCtx = ctx;
		if (!this.statusCtx?.hasUI) return;

		const running = this.runningEvents();
		const failed = this.unacknowledgedFailures();
		const stalled = running.map(({ event }) => backgroundEventStallKinds(event));
		const overdue = stalled.filter((kinds) => kinds.includes("overdue")).length;
		const silent = stalled.filter((kinds) => kinds.includes("silent")).length;
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
		if (overdue > 0) parts.push(`${overdue} overdue`);
		if (silent > 0) parts.push(`${silent} silent`);
		const needsAttention = failed.length > 0 || overdue > 0 || silent > 0;
		const icon = needsAttention ? "⚠ " : "● ";
		const iconColor: Parameters<typeof theme.fg>[0] = needsAttention ? "warning" : "accent";
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
			// Elapsed/time-based progress is presentation-only. Do not publish this
			// one-second refresh as real source activity to reminder observers.
			this.statusTimer = setInterval(() => this.update(undefined, false), 1000);
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

	/** Return a stable, serializable snapshot of all registered background work. */
	getEvents(): BackgroundEventSnapshot[] {
		return this.allEntries().map(({ source, event }) => ({
			...event,
			...(event.progress ? { progress: { ...event.progress } } : {}),
			sourceId: source.id,
			sourceTitle: source.title,
		}));
	}

	/** Cancel one event through its owning controller. */
	cancelEvent(sourceId: string, eventId: string, ctx?: ExtensionContext): boolean {
		return this.sources.get(sourceId)?.cancelEvent?.(eventId, ctx) ?? false;
	}

	/** Wait until no source reports running work, or until the optional deadline/abort fires. */
	waitForIdle(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (this.runningEvents().length === 0) return Promise.resolve(true);
		if (options.signal?.aborted) return Promise.resolve(false);

		return new Promise((resolve) => {
			let timeout: NodeJS.Timeout | undefined;
			let settled = false;
			let unsubscribe = () => {};

			const finish = (idle: boolean) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
				unsubscribe();
				resolve(idle);
			};
			const onAbort = () => finish(false);
			const onChange = (disposed: boolean) => {
				if (disposed) finish(false);
				else if (this.runningEvents().length === 0) finish(true);
			};

			unsubscribe = this.subscribeChanges(onChange);
			if (settled) {
				unsubscribe();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeoutMs !== undefined) {
				timeout = setTimeout(() => finish(false), Math.max(0, options.timeoutMs));
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.statusCtx?.ui.setStatus(STATUS_KEY, undefined);
		this.hide();
		this.statusCtx = undefined;
		this.stopTimer();
		this.emitChange(true);
		this.changeListeners.clear();
	}

	private emitChange(disposed: boolean): void {
		for (const listener of [...this.changeListeners]) {
			try {
				listener(disposed);
			} catch {
				// One observer must not prevent manager/UI updates or other observers.
			}
		}
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
		return this.allEntries().filter(({ event }) => isActiveStatus(event.status));
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
		if (this.filter === "running") return entries.filter(({ event }) => isActiveStatus(event.status));
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
