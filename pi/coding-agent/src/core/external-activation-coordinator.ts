/**
 * The single scheduling boundary for model-visible work produced outside the
 * AgentLoop. Sources submit typed payloads; this coordinator coalesces them and
 * commits one atomic batch per delivery lane.
 */

export type ExternalActivationDelivery = "steer" | "followUp" | "nextTurn";

export type ExternalActivationSource =
	| { kind: "peer"; messageIds: string[] }
	| { kind: "background"; controller: "bg_shell" | "sub_agent"; eventIds: string[] }
	| { kind: "reminder"; key: string };

export type ExternalActivationReceipt = {
	onPersisted: () => void;
	onDropped: (error: unknown) => void;
};

export type ExternalActivationMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: unknown;
};

export type ExternalActivationEntry = {
	/** Stable source-owned key. A later registration explicitly supersedes it. */
	key: string;
	source: ExternalActivationSource;
	/** IDs whose terminal inline consumption cancels this delivery. */
	consumeIds: string[];
	message: ExternalActivationMessage;
	delivery: ExternalActivationDelivery;
	/** Whether this entry may start a loop when the session is idle. */
	idlePolicy: "activate" | "passive";
	/** Called only after this payload has been persisted into session state. */
	onPersisted?: () => void;
	/** Best-effort rollback for rejection, cancellation, supersession, or failure. */
	onInjectionError?: (error: unknown) => void;
};

type DeliveryState = "pending" | "injecting" | "queued" | "committed";

type DeliveryRecord = {
	entry: ExternalActivationEntry;
	state: DeliveryState;
};

export type ExternalActivationCoordinatorDeps = {
	/** Commit one coalesced batch. Single messages use this same path. */
	injectBatch: (entries: ExternalActivationEntry[]) => Promise<void>;
	/** Remove an already queued, but not yet AgentLoop-drained, payload. */
	cancelQueued?: (entry: ExternalActivationEntry) => boolean;
	isShuttingDown?: () => boolean;
	onError?: (error: unknown) => void;
	batchWindowMs?: number;
};

const DEFAULT_BATCH_WINDOW_MS = 50;

export class ExternalActivationCoordinator {
	private readonly active = new Map<string, DeliveryRecord>();
	private readonly pending = new Map<string, DeliveryRecord>();
	private timer: NodeJS.Timeout | undefined;
	private inFlight: Promise<void> | undefined;
	private barrierDepth = 0;
	private releasingBarrier = false;
	private barrierSettled: Promise<void> | undefined;
	private resolveBarrierSettled: (() => void) | undefined;
	private stopped = false;
	private readonly deps: ExternalActivationCoordinatorDeps;
	private readonly batchWindowMs: number;

	constructor(deps: ExternalActivationCoordinatorDeps) {
		this.deps = deps;
		this.batchWindowMs = Math.max(0, deps.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS);
	}

	register(entry: ExternalActivationEntry): void {
		this.registerBatch([entry]);
	}

	registerBatch(entries: readonly ExternalActivationEntry[]): void {
		let registered = false;
		for (const entry of entries) {
			const cloned = this.cloneEntry(entry);
			if (this.stopped || this.deps.isShuttingDown?.()) {
				this.rollback(cloned, new Error(`External activation ${entry.key} was rejected during shutdown`));
				continue;
			}

			const prior = this.active.get(cloned.key);
			if (prior?.state === "committed") {
				this.rollback(cloned, new Error(`External activation ${cloned.key} cannot supersede committed context`));
				continue;
			}
			if (prior) {
				if (prior.state === "queued" && !this.deps.cancelQueued?.(prior.entry)) {
					this.rollback(cloned, new Error(`External activation ${cloned.key} is already entering context`));
					continue;
				}
				this.drop(prior, new Error(`External activation ${cloned.key} was superseded`));
			}

			const record: DeliveryRecord = { entry: cloned, state: "pending" };
			this.active.set(cloned.key, record);
			this.pending.set(cloned.key, record);
			registered = true;
		}
		if (registered && !this.isDeliveryBlocked()) this.armTimer();
	}

	/** Drop deliveries consumed inline before they enter model context. */
	cancel(consumeIds: readonly string[]): number {
		const ids = new Set(consumeIds);
		let cancelled = 0;
		for (const record of [...this.active.values()]) {
			if (!record.entry.consumeIds.some((id) => ids.has(id))) continue;
			if (record.state === "committed") continue;
			if (record.state === "queued" && !this.deps.cancelQueued?.(record.entry)) continue;
			this.drop(record, new Error(`External activation ${record.entry.key} was consumed inline`));
			cancelled++;
		}
		if (this.pending.size === 0) this.clearTimer();
		return cancelled;
	}

	isPending(consumeId: string): boolean {
		for (const record of this.active.values()) {
			if (record.entry.consumeIds.includes(consumeId) && record.state !== "committed") return true;
		}
		return false;
	}

	/** True until cancellation seals or persistence commits this entry. */
	isDeliverable(key: string): boolean {
		return this.active.has(key);
	}

	markQueued(key: string): void {
		const record = this.active.get(key);
		if (record?.state === "injecting") record.state = "queued";
	}

	/** The AgentLoop synchronously claimed this payload; it can no longer be cancelled. */
	markCommitted(key: string): void {
		const record = this.active.get(key);
		if (record) record.state = "committed";
	}

	markPersisted(key: string): void {
		const record = this.active.get(key);
		if (!record) return;
		this.active.delete(key);
		this.pending.delete(key);
		try {
			record.entry.onPersisted?.();
		} catch {
			// Persistence is already durable; source acknowledgement owns its retry.
		}
	}

	markFailed(key: string, error: unknown): void {
		const record = this.active.get(key);
		if (record) this.drop(record, error);
	}

	/**
	 * Hold every not-yet-committed delivery outside model context. Admission stays
	 * open while held: sources retain their durable claims and new entries continue
	 * to coalesce in `pending`. Already queued Agent messages are pulled back when
	 * possible so a compaction can snapshot and replace context without racing a
	 * safe-boundary drain.
	 *
	 * The returned release is idempotent. The outermost release commits everything
	 * accumulated behind the barrier before waking waiters, including registrations
	 * that race with barrier settlement.
	 */
	async acquireDeliveryBarrier(): Promise<() => Promise<void>> {
		if (this.stopped) return async () => {};
		this.barrierDepth++;
		this.ensureBarrierSignal();
		this.clearTimer();
		await this.settleBehindBarrier();

		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await this.releaseDeliveryBarrier();
		};
	}

	/** Wait until the current barrier has released and its coalesced batch committed. */
	async waitForDeliveryReady(): Promise<void> {
		while (this.isDeliveryBlocked()) {
			const settled = this.barrierSettled;
			if (!settled) return;
			await settled;
		}
	}

	/** Commit immediately at a known AgentLoop boundary. */
	async flushReady(): Promise<void> {
		this.clearTimer();
		if (this.isDeliveryBlocked()) {
			await this.inFlight;
			return;
		}
		await this.flush();
	}

	/** Scheduling quiescence excludes intentionally queued nextTurn context. */
	hasPending(): boolean {
		return this.pending.size > 0 || this.timer !== undefined || this.inFlight !== undefined;
	}

	/** Explicit barrier for one-shot/headless settlement. */
	async waitForQuiescence(options?: { timeoutMs?: number }): Promise<boolean> {
		const deadline = options?.timeoutMs === undefined ? undefined : Date.now() + Math.max(0, options.timeoutMs);
		while (true) {
			await Promise.resolve();
			if (!this.hasPending()) return true;

			if (this.isDeliveryBlocked()) {
				const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
				if (remaining === 0) return false;
				const settled = this.barrierSettled ?? Promise.resolve();
				if (remaining === undefined) {
					await settled;
					continue;
				}
				let barrierTimer: NodeJS.Timeout | undefined;
				const released = await Promise.race([
					settled.then(() => true),
					new Promise<boolean>((resolve) => {
						barrierTimer = setTimeout(() => resolve(false), remaining);
					}),
				]);
				if (barrierTimer) clearTimeout(barrierTimer);
				if (!released) return false;
				continue;
			}

			const flush = this.flushReady();
			if (deadline === undefined) {
				await flush;
				continue;
			}
			const remaining = Math.max(0, deadline - Date.now());
			if (remaining === 0) return false;
			let timer: NodeJS.Timeout | undefined;
			const completed = await Promise.race([
				flush.then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), remaining);
				}),
			]);
			if (timer) clearTimeout(timer);
			if (!completed) return false;
		}
	}

	async shutdown(): Promise<void> {
		this.stopped = true;
		this.barrierDepth = 0;
		this.releasingBarrier = false;
		this.clearTimer();
		for (const record of [...this.active.values()]) {
			if (record.state === "committed") continue;
			if (record.state === "queued" && !this.deps.cancelQueued?.(record.entry)) {
				// The AgentLoop already owns an uncancellable payload. Rolling its source
				// claim back here could redeliver it while the queued copy still commits.
				record.state = "committed";
				continue;
			}
			this.drop(record, new Error(`External activation ${record.entry.key} was dropped during shutdown`));
		}
		await this.inFlight;
		for (const record of [...this.active.values()]) {
			if (record.state === "committed") continue;
			this.drop(record, new Error(`External activation ${record.entry.key} did not settle before shutdown`));
		}
		this.settleBarrierSignal();
	}

	private cloneEntry(entry: ExternalActivationEntry): ExternalActivationEntry {
		return {
			...entry,
			consumeIds: [...entry.consumeIds],
			source:
				entry.source.kind === "peer"
					? { kind: "peer", messageIds: [...entry.source.messageIds] }
					: entry.source.kind === "background"
						? { ...entry.source, eventIds: [...entry.source.eventIds] }
						: { ...entry.source },
		};
	}

	private armTimer(): void {
		if (this.timer || this.isDeliveryBlocked()) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.batchWindowMs);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private async flush(options?: { bypassReleasingBarrier?: boolean }): Promise<void> {
		if (!this.canFlush(options)) return;
		if (this.pending.size === 0) {
			await this.inFlight;
			return;
		}

		const drained = [...this.pending.values()];
		this.pending.clear();
		for (const record of drained) record.state = "injecting";
		const prior = this.inFlight ?? Promise.resolve();
		const operation = prior.then(async () => {
			const deliverable = drained.filter((record) => this.active.get(record.entry.key) === record);
			if (deliverable.length === 0) return;
			if (!this.canFlush(options)) {
				this.deferRecords(deliverable);
				return;
			}
			await this.deps.injectBatch(deliverable.map((record) => record.entry));
			for (const record of deliverable) {
				if (this.active.get(record.entry.key) === record && record.state === "injecting") {
					this.drop(record, new Error(`External activation ${record.entry.key} was not committed by its host`));
				}
			}
		});
		let tracked!: Promise<void>;
		tracked = operation
			.catch((error) => {
				for (const record of drained) {
					if (this.active.get(record.entry.key) === record) this.drop(record, error);
				}
				this.deps.onError?.(error);
			})
			.finally(() => {
				if (this.inFlight === tracked) this.inFlight = undefined;
			});
		this.inFlight = tracked;
		await tracked;
	}

	private isDeliveryBlocked(): boolean {
		return this.barrierDepth > 0 || this.releasingBarrier;
	}

	private canFlush(options?: { bypassReleasingBarrier?: boolean }): boolean {
		if (this.barrierDepth > 0) return false;
		return !this.releasingBarrier || options?.bypassReleasingBarrier === true;
	}

	private ensureBarrierSignal(): void {
		if (this.barrierSettled) return;
		this.barrierSettled = new Promise<void>((resolve) => {
			this.resolveBarrierSettled = resolve;
		});
	}

	private settleBarrierSignal(): void {
		const resolve = this.resolveBarrierSettled;
		this.resolveBarrierSettled = undefined;
		this.barrierSettled = undefined;
		resolve?.();
	}

	private deferRecords(records: readonly DeliveryRecord[]): void {
		for (const record of records) {
			if (this.active.get(record.entry.key) !== record || record.state === "committed") continue;
			if (record.state === "queued" && !this.deps.cancelQueued?.(record.entry)) continue;
			record.state = "pending";
			this.pending.set(record.entry.key, record);
		}
	}

	private async settleBehindBarrier(): Promise<void> {
		while (true) {
			const inFlight = this.inFlight;
			if (inFlight) await inFlight;
			this.deferRecords([...this.active.values()]);
			if (!this.inFlight) return;
		}
	}

	private async releaseDeliveryBarrier(): Promise<void> {
		if (this.barrierDepth === 0) return;
		this.barrierDepth--;
		if (this.barrierDepth > 0) return;
		if (this.stopped) {
			this.settleBarrierSignal();
			return;
		}

		this.releasingBarrier = true;
		try {
			// Admit same-tick completion callbacks into the release batch, then keep
			// draining if an asynchronous injection raced with another registration.
			await Promise.resolve();
			while (this.barrierDepth === 0 && this.pending.size > 0) {
				await this.flush({ bypassReleasingBarrier: true });
			}
		} finally {
			this.releasingBarrier = false;
			// A new/nested holder may have latched while the outer release awaited
			// injection. Keep the shared gate closed and leave its deferred records in
			// `pending`; only the new outermost release may bypass its own release phase.
			if (this.barrierDepth === 0) {
				this.settleBarrierSignal();
				if (this.pending.size > 0) this.armTimer();
			}
		}
	}

	private drop(record: DeliveryRecord, error: unknown): void {
		if (this.active.get(record.entry.key) !== record) return;
		this.active.delete(record.entry.key);
		this.pending.delete(record.entry.key);
		this.rollback(record.entry, error);
	}

	private rollback(entry: ExternalActivationEntry, error: unknown): void {
		try {
			entry.onInjectionError?.(error);
		} catch {
			// One source's rollback must never break the remaining batch.
		}
	}
}
