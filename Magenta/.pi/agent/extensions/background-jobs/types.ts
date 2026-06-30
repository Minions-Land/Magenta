import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JobStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled" | string;

export type MonitoredJob = {
	id: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	label: string;
	cwd?: string;
	logPath?: string;
	tail?: string;
	canCancel?: boolean;
};

export type JobSource = {
	id: string;
	title: string;
	getJobs: () => MonitoredJob[];
	getJobDetails?: (id: string) => string[];
	cancelJob?: (id: string, ctx?: ExtensionContext) => boolean;
};

export type JobFilter = "all" | "failed" | "running" | "exited" | string;

export type JobEntry = {
	source: JobSource;
	job: MonitoredJob;
	key: string;
};

export type NotifyLevel = "info" | "warning" | "error";

export type TuiLike = {
	requestRender: () => void;
};
