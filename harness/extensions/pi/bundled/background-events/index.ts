// Background events extension.
//
// Agent-facing tools:
// - bg_shell_* for long-running shell commands
// - sub_agent for parallel headless Pi workers
//
// User-facing UI:
// - /events unified observation panel

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installBackgroundShell } from "./background-shell.ts";
import { createEventsMonitor } from "./event-monitor.ts";
import { installSubAgents } from "./sub-agents.ts";

export default function backgroundEvents(pi: ExtensionAPI) {
	const monitor = createEventsMonitor(pi);
	installBackgroundShell(pi, monitor);
	installSubAgents(pi, monitor);
}
