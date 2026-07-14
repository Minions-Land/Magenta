/**
 * Batches completed background-event returns (bg_shell + sub_agent) so that
 * several near-simultaneous completions enter the agent's context in ONE turn
 * instead of each triggering its own separate continuation.
 *
 * Design principle (see AGENTS.md "统一调度，传输各自诚实"): this coordinator owns
 * only the *scheduling* layer. Each controller still formats and byte-bounds its
 * own message and keeps its own TUI renderer (`bg-shell-return`/`sub-agent-return`).
 * The coordinator never reformats payloads — it just decides WHEN a group of
 * already-formed returns is injected.
 *
 * Behavior:
 * - IDLE: accumulate returns behind a short debounce, then append them all to the
 *   session and trigger exactly ONE continuation turn.
 * - STREAMING: deliver immediately as followUp; the agent loop's own queue drain
 *   coalesces them at turn end (no debounce needed).
 *
 * Consumption: a terminal wait/status on an event calls cancel([id]) to drop it
 * from a still-pending batch (clearing the timer if the batch empties), matching
 * the existing autoReturnPending semantics.
 */

type ReturnDelivery = "steer" | "followUp" | "nextTurn";

/** A fully-formed, self-bounded custom message produced by a controller. */
export type BackgroundReturnMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: unknown;
};

type PendingReturn = {
	/** All event ids this return covers. A terminal wait/status on ANY of them
	 * cancels the whole entry (a sub_agent batch may cover several ids). */
	eventIds: string[];
	message: BackgroundReturnMessage;
	delivery: ReturnDelivery;
};

export type BackgroundReturnCoordinatorDeps = {
	/**
	 * Append a group of custom messages to the session and, when idle and
	 * triggerTurn is set, start exactly ONE continuation turn covering all of
	 * them. When streaming, each is queued (followUp/steer) per its delivery mode.
	 */
	injectBatch: (messages: Array<{ message: BackgroundReturnMessage; delivery: ReturnDelivery }>) => Promise<void>;
	/** Deliver a single return immediately (used on the streaming path). */
	injectSingle: (message: BackgroundReturnMessage, delivery: ReturnDelivery) => Promise<void>;
	/** Whether the agent is currently streaming. */
	isStreaming: () => boolean;
	/** Whether the owning session is shutting down. */
	isShuttingDown?: () => boolean;
};

const IDLE_DEBOUNCE_MS = 50;

export class BackgroundReturnCoordinator {
	private pending: Map<string, PendingReturn> = new Map();
	private timer: NodeJS.Timeout | undefined;
	private stopped = false;
	private readonly deps: BackgroundReturnCoordinatorDeps;

	constructor(deps: BackgroundReturnCoordinatorDeps) {
		this.deps = deps;
	}

	/**
	 * Register a completed background return. IDLE: queue + (re)arm the debounce.
	 * STREAMING: deliver immediately (agent loop batches on its own).
	 *
	 * `eventIds` lists every event the return covers; a terminal wait/status on any
	 * of them cancels the entry. `key` is the stable map key (first event id).
	 */
	register(params: {
		key: string;
		eventIds: string[];
		message: BackgroundReturnMessage;
		delivery: ReturnDelivery;
	}): void {
		if (this.stopped || this.deps.isShuttingDown?.()) return;

		if (this.deps.isStreaming()) {
			void this.deps.injectSingle(params.message, params.delivery).catch(() => undefined);
			return;
		}

		this.pending.set(params.key, {
			eventIds: params.eventIds,
			message: params.message,
			delivery: params.delivery,
		});
		this.armTimer();
	}

	/**
	 * Drop pending returns covering any of the given event IDs (terminal
	 * wait/status consumption). A batch is removed if any of its member ids is
	 * consumed. Clears the timer if nothing remains queued.
	 */
	cancel(eventIds: string[]): void {
		const toCancel = new Set(eventIds);
		let changed = false;
		for (const [key, entry] of this.pending) {
			if (entry.eventIds.some((id) => toCancel.has(id))) {
				this.pending.delete(key);
				changed = true;
			}
		}
		if (changed && this.pending.size === 0 && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Whether any queued (not yet flushed) return covers the given event. */
	isPending(eventId: string): boolean {
		for (const entry of this.pending.values()) {
			if (entry.eventIds.includes(eventId)) return true;
		}
		return false;
	}

	/**
	 * Flush any accumulated batch now. Safe to call at turn boundaries; a no-op
	 * when nothing is queued.
	 */
	flushReady(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.pending.size === 0) return;
		void this.flush();
	}

	shutdown(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending.clear();
	}

	private armTimer(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, IDLE_DEBOUNCE_MS);
	}

	private async flush(): Promise<void> {
		if (this.pending.size === 0) return;
		// If a turn started between arming and firing, hand off to the streaming
		// path so the agent loop batches naturally instead of forcing a new turn.
		const drained = Array.from(this.pending.values());
		this.pending.clear();

		if (this.deps.isStreaming()) {
			for (const entry of drained) {
				await this.deps.injectSingle(entry.message, entry.delivery).catch(() => undefined);
			}
			return;
		}

		await this.deps
			.injectBatch(drained.map((entry) => ({ message: entry.message, delivery: entry.delivery })))
			.catch(() => undefined);
	}
}
