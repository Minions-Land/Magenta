import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
