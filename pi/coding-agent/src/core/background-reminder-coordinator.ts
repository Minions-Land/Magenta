import {
	type BackgroundEventManager,
	type BackgroundEventSnapshot,
	type BackgroundReminderThresholds,
	type BackgroundStallKind,
	backgroundEventDeadlines,
	backgroundEventStallKinds,
	DEFAULT_BACKGROUND_REMINDER_THRESHOLDS,
} from "./background-events.ts";

export const DEFAULT_BACKGROUND_REMINDER_TIMING = {
	batchWindowMs: 1_000,
	globalRateLimitMs: 5 * 60_000,
} as const;
const DEFAULT_REMINDER_KEY = "background-stall-reminder";

type StallNotice = {
	key: string;
	epoch: string;
	event: BackgroundEventSnapshot;
	kinds: BackgroundStallKind[];
	readyAt: number;
};

export type BackgroundReminderCoordinatorOptions = {
	upsertNextTurn: (key: string, message: string) => void;
	removeNextTurn: (key: string) => void;
	thresholds?: Partial<BackgroundReminderThresholds>;
	batchWindowMs?: number;
	globalRateLimitMs?: number;
	reminderKey?: string;
	now?: () => number;
};

/**
 * Converts overdue/silent background events into one passive keyed next-turn
 * reminder. Scheduling is deadline-driven: at most one unref'ed timeout exists,
 * always targeting the nearest event, batch, or rate-limit deadline.
 */
export class BackgroundReminderCoordinator {
	private readonly manager: BackgroundEventManager;
	private readonly upsertNextTurn: (key: string, message: string) => void;
	private readonly removeNextTurn: (key: string) => void;
	private readonly thresholds: BackgroundReminderThresholds;
	private readonly batchWindowMs: number;
	private readonly globalRateLimitMs: number;
	private readonly reminderKey: string;
	private readonly now: () => number;
	private readonly pending = new Map<string, StallNotice>();
	private readonly queued = new Map<string, StallNotice>();
	private readonly notifiedEpochs = new Map<string, string>();
	private unsubscribe: (() => void) | undefined;
	private timer: NodeJS.Timeout | undefined;
	private timerAt: number | undefined;
	private lastReminderAt = Number.NEGATIVE_INFINITY;
	private disposed = false;

	constructor(manager: BackgroundEventManager, options: BackgroundReminderCoordinatorOptions) {
		this.manager = manager;
		this.upsertNextTurn = options.upsertNextTurn;
		this.removeNextTurn = options.removeNextTurn;
		this.thresholds = { ...DEFAULT_BACKGROUND_REMINDER_THRESHOLDS, ...options.thresholds };
		this.batchWindowMs = Math.max(0, options.batchWindowMs ?? DEFAULT_BACKGROUND_REMINDER_TIMING.batchWindowMs);
		this.globalRateLimitMs = Math.max(
			0,
			options.globalRateLimitMs ?? DEFAULT_BACKGROUND_REMINDER_TIMING.globalRateLimitMs,
		);
		this.reminderKey = options.reminderKey ?? DEFAULT_REMINDER_KEY;
		this.now = options.now ?? Date.now;
		this.unsubscribe = manager.subscribeChanges((managerDisposed) => {
			if (managerDisposed) this.dispose();
			else this.reconcile();
		});
		this.reconcile();
	}

	/** Mark the currently queued reminder as delivered by a natural next turn. */
	markNextTurnDelivered(): void {
		if (this.disposed || this.queued.size === 0) return;
		this.queued.clear();
		this.safeRemove();
		this.reconcile();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.clearTimer();
		this.pending.clear();
		this.queued.clear();
		this.notifiedEpochs.clear();
		this.safeRemove();
	}

	private reconcile(): void {
		if (this.disposed) return;
		const now = this.now();
		const events = this.manager.getEvents();
		const current = new Map(events.map((event) => [this.eventKey(event), event]));
		let queuedChanged = false;

		for (const [key, notice] of this.pending) {
			const event = current.get(key);
			if (!event || event.status !== "running" || this.stallEpoch(event) !== notice.epoch) this.pending.delete(key);
		}
		for (const [key, notice] of this.queued) {
			const event = current.get(key);
			if (!event || event.status !== "running" || this.stallEpoch(event) !== notice.epoch) {
				this.queued.delete(key);
				queuedChanged = true;
			}
		}
		for (const key of this.notifiedEpochs.keys()) {
			if (!current.has(key)) this.notifiedEpochs.delete(key);
		}

		for (const event of events) {
			const key = this.eventKey(event);
			const epoch = this.stallEpoch(event);
			const kinds = backgroundEventStallKinds(event, now, this.thresholds);
			if (kinds.length === 0) continue;
			if (this.notifiedEpochs.get(key) === epoch || this.pending.has(key) || this.queued.has(key)) continue;
			this.pending.set(key, { key, epoch, event, kinds, readyAt: now + this.batchWindowMs });
		}

		if (queuedChanged) this.publishQueued();
		this.flushReady(now);
		this.scheduleNext(now, events);
	}

	private flushReady(now: number): void {
		const ready = [...this.pending.values()].filter((notice) => notice.readyAt <= now);
		if (ready.length === 0 || now < this.lastReminderAt + this.globalRateLimitMs) return;
		for (const notice of ready) {
			this.pending.delete(notice.key);
			this.queued.set(notice.key, notice);
			this.notifiedEpochs.set(notice.key, notice.epoch);
		}
		this.lastReminderAt = now;
		this.publishQueued();
	}

	private publishQueued(): void {
		if (this.queued.size === 0) {
			this.safeRemove();
			return;
		}
		const notices = [...this.queued.values()].sort((a, b) => a.event.startedAt - b.event.startedAt);
		const lines = [
			"Background work may need attention. Re-check these events and decide whether to wait, inspect, cancel, or adjust the task:",
		];
		for (const notice of notices) {
			const event = notice.event;
			const phase = event.activityPhase ? `, phase=${event.activityPhase}` : "";
			lines.push(`- ${event.sourceId}:${event.id} (${event.label}): ${notice.kinds.join(" and ")}${phase}`);
		}
		try {
			this.upsertNextTurn(this.reminderKey, lines.join("\n"));
		} catch {
			// Session delivery may already be unavailable during shutdown.
		}
	}

	private scheduleNext(now: number, events: BackgroundEventSnapshot[]): void {
		let nextAt = Number.POSITIVE_INFINITY;
		for (const notice of this.pending.values()) {
			nextAt = Math.min(nextAt, Math.max(notice.readyAt, this.lastReminderAt + this.globalRateLimitMs));
		}
		for (const event of events) {
			if (event.status !== "running" || event.reminderEligible !== true) continue;
			const key = this.eventKey(event);
			const epoch = this.stallEpoch(event);
			if (this.notifiedEpochs.get(key) === epoch || this.pending.has(key) || this.queued.has(key)) continue;
			const deadlines = backgroundEventDeadlines(event, this.thresholds);
			if (deadlines.overdueAt !== undefined && deadlines.overdueAt > now)
				nextAt = Math.min(nextAt, deadlines.overdueAt);
			if (deadlines.silentAt !== undefined && deadlines.silentAt > now)
				nextAt = Math.min(nextAt, deadlines.silentAt);
		}
		if (!Number.isFinite(nextAt)) {
			this.clearTimer();
			return;
		}
		this.setTimer(nextAt);
	}

	private setTimer(at: number): void {
		if (this.timer && this.timerAt === at) return;
		this.clearTimer();
		this.timerAt = at;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				this.timerAt = undefined;
				this.reconcile();
			},
			Math.max(0, at - this.now()),
		);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = undefined;
	}

	private safeRemove(): void {
		try {
			this.removeNextTurn(this.reminderKey);
		} catch {
			// Session delivery may already be unavailable during shutdown.
		}
	}

	private eventKey(event: BackgroundEventSnapshot): string {
		return `${event.sourceId}:${event.id}:${event.startedAt}`;
	}

	private stallEpoch(event: BackgroundEventSnapshot): string {
		return [
			event.lastActivityAt ?? event.startedAt,
			event.lastOutputAt ?? "",
			event.lastProgressAt ?? "",
			event.activityPhase ?? "",
		].join(":");
	}
}
