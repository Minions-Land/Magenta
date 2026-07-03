import type { AgentSessionEvent } from "./agent-session.ts";

export type ToolProgressEntry = {
	id: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	status: "running" | "finished";
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
};

function compactValue(value: unknown, maxLength = 1200): string {
	let text: string;
	try {
		const json = typeof value === "string" ? value : JSON.stringify(value);
		text = json ?? String(value);
	} catch {
		text = String(value);
	}
	if (!text) return "";
	text = text.replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export class ToolProgressTracker {
	private entries = new Map<string, ToolProgressEntry>();

	clear(): void {
		this.entries.clear();
	}

	handleAgentEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.clear();
			return;
		}
		if (event.type === "tool_execution_start") {
			const now = Date.now();
			this.entries.set(event.toolCallId, {
				id: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				status: "running",
				startedAt: now,
				updatedAt: now,
			});
			this.prune();
			return;
		}
		if (event.type === "tool_execution_update") {
			const existing = this.entries.get(event.toolCallId);
			if (!existing) {
				const now = Date.now();
				this.entries.set(event.toolCallId, {
					id: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
					status: "running",
					startedAt: now,
					updatedAt: now,
				});
				return;
			}
			existing.args = event.args ?? existing.args;
			existing.partialResult = event.partialResult;
			existing.updatedAt = Date.now();
			return;
		}
		if (event.type === "tool_execution_end") {
			const existing = this.entries.get(event.toolCallId);
			const now = Date.now();
			this.entries.set(event.toolCallId, {
				id: event.toolCallId,
				toolName: event.toolName,
				args: existing?.args,
				partialResult: existing?.partialResult,
				result: event.result,
				isError: event.isError,
				status: "finished",
				startedAt: existing?.startedAt ?? now,
				updatedAt: now,
				endedAt: now,
			});
			this.prune();
		}
	}

	format(maxEntries = 20): string {
		const entries = [...this.entries.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-maxEntries);
		if (!entries.length) return "No main-agent tool executions have been observed yet.";

		const now = Date.now();
		return entries
			.map((entry) => {
				const elapsed = Math.max(0, Math.round(((entry.endedAt ?? now) - entry.startedAt) / 1000));
				const lines = [
					`- ${entry.toolName} (${entry.status}${entry.isError ? ", error" : ""}, ${elapsed}s, id=${entry.id})`,
				];
				const args = compactValue(entry.args, 700);
				if (args) lines.push(`  args: ${args}`);
				const partial = compactValue(entry.partialResult, 900);
				if (entry.status === "running" && partial) lines.push(`  latest update: ${partial}`);
				const result = compactValue(entry.result, 900);
				if (entry.status === "finished" && result) lines.push(`  result: ${result}`);
				return lines.join("\n");
			})
			.join("\n");
	}

	private prune(maxEntries = 40): void {
		const entries = [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		for (const entry of entries.slice(maxEntries)) this.entries.delete(entry.id);
	}
}
