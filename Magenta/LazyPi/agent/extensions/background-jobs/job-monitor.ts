import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CENTER_FLOATING_OVERLAY } from "../shared/floating-window.ts";
import { JobsOverlay } from "./jobs-overlay.ts";
import type { JobEntry, JobFilter, JobSource, NotifyLevel, TuiLike } from "./types.ts";

export type { JobSource, MonitoredJob } from "./types.ts";

const STATUS_KEY = "background-jobs";
const FAILED_STATUSES = new Set(["failed", "timed_out"]);
const DONE_STATUSES = new Set(["exited", "cancelled"]);

function jobKey(sourceId: string, jobId: string): string {
	return `${sourceId}:${jobId}`;
}

export function createJobsMonitor(pi: ExtensionAPI) {
	const sources = new Map<string, JobSource>();
	const acknowledgedFailures = new Set<string>();
	let statusCtx: ExtensionContext | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	let overlayVisible = false;
	let overlayDone: (() => void) | undefined;
	let overlayTui: TuiLike | undefined;
	let filter: JobFilter = "all";

	const stopTimer = () => {
		if (!statusTimer) return;
		clearInterval(statusTimer);
		statusTimer = undefined;
	};

	const sourceEntries = () => [...sources.values()];
	const sourceJobs = (source: JobSource) => source.getJobs().sort((a, b) => b.startedAt - a.startedAt);
	const allEntries = (): JobEntry[] => sourceEntries()
		.flatMap((source) => sourceJobs(source).map((job) => ({ source, job, key: jobKey(source.id, job.id) })))
		.sort((a, b) => b.job.startedAt - a.job.startedAt);
	const runningJobs = () => allEntries().filter(({ job }) => job.status === "running");
	const unacknowledgedFailures = () => allEntries().filter(({ key, job }) => FAILED_STATUSES.has(job.status) && !acknowledgedFailures.has(key));

	const visibleEntries = (): JobEntry[] => {
		const entries = allEntries();
		if (filter === "all") return entries;
		if (filter === "failed") return entries.filter(({ job }) => FAILED_STATUSES.has(job.status));
		if (filter === "running") return entries.filter(({ job }) => job.status === "running");
		if (filter === "exited") return entries.filter(({ job }) => DONE_STATUSES.has(job.status));
		return entries.filter(({ source }) => source.id === filter);
	};

	const updateOverlay = () => {
		if (!overlayVisible || !statusCtx?.hasUI) return;
		overlayTui?.requestRender();
	};

	const update = (ctx?: ExtensionContext) => {
		if (ctx?.hasUI) statusCtx = ctx;
		if (!statusCtx?.hasUI) return;

		const running = runningJobs();
		const failed = unacknowledgedFailures();
		const theme = statusCtx.ui.theme;

		if (running.length === 0 && failed.length === 0) {
			statusCtx.ui.setStatus(STATUS_KEY, undefined);
			updateOverlay();
			stopTimer();
			return;
		}

		const parts: string[] = [];
		if (running.length > 0) parts.push(`${running.length} running`);
		if (failed.length > 0) parts.push(`${failed.length} failed`);
		const icon = failed.length > 0 && running.length === 0 ? "⚠ " : running.length > 0 ? "● " : "⚠ ";
		const iconColor: Parameters<typeof theme.fg>[0] = failed.length > 0 && running.length === 0 ? "warning" : "accent";
		statusCtx.ui.setStatus(STATUS_KEY, theme.fg(iconColor, icon) + theme.fg("dim", `bg: ${parts.join(", ")}`));
		updateOverlay();

		if (running.length > 0 && !statusTimer) {
			statusTimer = setInterval(() => update(), 1000);
			statusTimer.unref?.();
		}
		if (running.length === 0) stopTimer();
	};

	const clearFailures = () => {
		for (const { key, job } of allEntries()) {
			if (FAILED_STATUSES.has(job.status)) acknowledgedFailures.add(key);
		}
		update();
	};

	const notify = (ctx: ExtensionContext, message: string, level: NotifyLevel = "info") => {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// UI may no longer be available.
		}
	};

	const show = async (ctx: ExtensionContext, nextFilter: JobFilter = filter) => {
		filter = nextFilter;
		statusCtx = ctx;
		update(ctx);

		if (overlayVisible) {
			updateOverlay();
			return;
		}

		overlayVisible = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					overlayDone = done;
					return new JobsOverlay(
						tui,
						theme,
						done,
						() => filter,
						(next) => {
							filter = next;
						},
						visibleEntries,
						() => [...sources.keys()],
						(message, level) => notify(ctx, message, level),
						clearFailures,
					);
				},
				{
					overlay: true,
					onHandle: (handle) => handle.focus(),
					overlayOptions: CENTER_FLOATING_OVERLAY,
				},
			);
		} finally {
			overlayVisible = false;
			overlayDone = undefined;
			overlayTui = undefined;
		}
	};

	const hide = () => {
		overlayDone?.();
		overlayVisible = false;
		overlayTui = undefined;
		overlayDone = undefined;
	};

	const handleCommand = async (args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const action = args.trim().toLowerCase();

		if (action === "clear") {
			clearFailures();
			return;
		}
		if (action === "close" || action === "hide") {
			hide();
			return;
		}
		if (action === "open") {
			await show(ctx, "all");
			return;
		}
		if (["all", "failed", "running", "exited"].includes(action)) {
			await show(ctx, action as JobFilter);
			return;
		}
		if (sources.has(action)) {
			await show(ctx, action);
			return;
		}

		if (overlayVisible && filter === "all") hide();
		else await show(ctx, "all");
	};

	pi.on("session_start", (_event, ctx) => {
		update(ctx);
	});

	pi.on("session_shutdown", async () => {
		statusCtx?.ui.setStatus(STATUS_KEY, undefined);
		hide();
		statusCtx = undefined;
		stopTimer();
	});

	pi.registerCommand("jobs", {
		description: "Show background work started by the main agent",
		handler: async (args, ctx) => handleCommand(args, ctx),
	});

	return {
		registerSource(source: JobSource) {
			sources.set(source.id, source);
			return { update };
		},
		update,
	};
}
