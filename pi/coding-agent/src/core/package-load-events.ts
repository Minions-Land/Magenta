import type { PackageAssemblyProgress } from "@magenta/harness";
import type { BackgroundEventManager, MonitoredEvent } from "./background-events.ts";

/**
 * Surfaces harness package assembly as a background event with a live progress
 * bar, reusing the same {@link BackgroundEventManager} source-pull mechanism as
 * background shells and sub-agents. Package assembly walks a component list and
 * may spawn MCP servers (or, for process tools, trigger a cargo build) — a
 * multi-hundred-millisecond-to-multi-second step that was previously silent.
 *
 * The controller owns one event ("assembly") that runs for the duration of a
 * reload's assembly phase. It is driven purely by the {@link PackageAssemblyProgress}
 * callback threaded into `assemblePackageToolMagnets`: each component start
 * advances the progress fraction (index/total) and updates the label to name the
 * component currently being built.
 */
export class PackageLoadController {
	private readonly monitor: { update: () => void };
	private event: MonitoredEvent | undefined;

	constructor(manager: BackgroundEventManager) {
		this.monitor = manager.registerSource({
			id: "package-load",
			title: "packages",
			getEvents: () => (this.event ? [this.event] : []),
		});
	}

	/**
	 * Begin a fresh assembly event. Any prior event is replaced so the overlay
	 * only ever shows the current reload.
	 */
	begin(total: number): void {
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
	 * The callback handed to `assemblePackageToolMagnets`. `start` moves the bar
	 * to the fraction of components already finished and names the one now being
	 * built; `assembled` advances the fraction to include it.
	 */
	readonly onProgress = (progress: PackageAssemblyProgress): void => {
		if (!this.event) this.begin(progress.total);
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

	/** Mark the assembly event finished. Called once the reload's assembly returns. */
	finish(): void {
		if (!this.event) return;
		this.event.status = "exited";
		this.event.endedAt = Date.now();
		this.event.progress = { value: 1, source: "output" };
		this.monitor.update();
	}
}
