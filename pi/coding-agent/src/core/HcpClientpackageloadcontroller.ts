import type { HcpClientpackageassemblyprogress } from "@magenta/harness";
import type { BackgroundEventManager, MonitoredEvent } from "./background-events.ts";

/**
 * Surfaces harness package assembly as a background event with a live progress
 * bar, reusing the same {@link BackgroundEventManager} source-pull mechanism as
 * background shells and sub-agents. Package assembly walks a component list and
 * may spawn MCP servers (or, for process tools, trigger a cargo build) — a
 * multi-hundred-millisecond-to-multi-second step that was previously silent.
 *
 * One event is retained for the activity gallery, while `active` identifies
 * whether the current reload actually emitted Package assembly progress. This
 * prevents an unrelated reload failure from rewriting an older Package event.
 */
export class HcpClientpackageloadcontroller {
	private readonly monitor: { update: () => void };
	private event: MonitoredEvent | undefined;
	private active = false;

	constructor(manager: BackgroundEventManager) {
		this.monitor = manager.registerSource({
			id: "package-load",
			title: "packages",
			getEvents: () => (this.event ? [this.event] : []),
		});
	}

	/** Begin a fresh assembly event, replacing any event from an earlier reload. */
	begin(total: number): void {
		this.active = true;
		this.event = {
			id: "assembly",
			status: "running",
			startedAt: Date.now(),
			label: total > 0 ? `Assembling ${total} package component(s)` : "Assembling packages",
			progress: { value: 0, source: "output" },
		};
		this.monitor.update();
	}

	/**
	 * The callback handed to Package assembly. The first callback of every reload
	 * starts a new event, including after an earlier event has completed or failed.
	 */
	readonly onProgress = (progress: HcpClientpackageassemblyprogress): void => {
		if (!this.active) this.begin(progress.total);
		const event = this.event;
		if (!event) return;
		const total = progress.total || 1;
		const done = progress.phase === "assembled" ? progress.index + 1 : progress.index;
		event.progress = { value: Math.min(done / total, 1), source: "output" };
		if (progress.phase === "start") {
			event.label = `Building ${progress.component.kind} ${progress.component.name} (${progress.index + 1}/${progress.total})`;
		}
		this.monitor.update();
	};

	/** Mark this reload's Package assembly event finished, if it emitted one. */
	finish(): void {
		if (!this.active || !this.event) return;
		this.event.status = "exited";
		this.event.endedAt = Date.now();
		this.event.progress = { value: 1, source: "output" };
		this.active = false;
		this.monitor.update();
	}

	/** Mark this reload's Package assembly event failed, if it emitted one. */
	fail(error?: unknown): void {
		if (!this.active || !this.event) return;
		this.event.status = "failed";
		this.event.endedAt = Date.now();
		const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
		this.event.label = message ? `Package load failed: ${message}` : "Package load failed";
		this.active = false;
		this.monitor.update();
	}
}
