import type { Registry } from "@magenta/harness";
import type { ToolInfo } from "./extensions/index.ts";

export const HARNESS_HOOK_EVENTS = [
	"resources_discover",
	"session_start",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_shutdown",
	"session_before_tree",
	"session_tree",
	"context",
	"before_provider_request",
	"after_provider_response",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
	"tool_call",
	"tool_result",
	"user_bash",
	"input",
] as const;

export interface HarnessRegistryView {
	path?: string;
	registry?: Registry;
	error?: string;
}

export interface HarnessToolSwitch {
	name: string;
	active: boolean;
	description?: string;
	source: string;
}

export interface HarnessRuntimeSnapshot {
	autoCompact: boolean;
	skillCommands: boolean;
	loadedSkills: number;
	loadedExtensions: number;
	tools: HarnessToolSwitch[];
	activeHookEvents: string[];
	registry: HarnessRegistryView;
}

export function buildHarnessToolSwitches(tools: ToolInfo[], activeToolNames: string[]): HarnessToolSwitch[] {
	const active = new Set(activeToolNames);
	return tools
		.map((tool) => ({
			name: tool.name,
			active: active.has(tool.name),
			description: tool.description,
			source: tool.sourceInfo.source,
		}))
		.sort((a, b) => {
			if (a.source === "builtin" && b.source !== "builtin") return -1;
			if (a.source !== "builtin" && b.source === "builtin") return 1;
			return a.name.localeCompare(b.name);
		});
}

export function countRegistryComponentsByKind(registry: Registry | undefined): Map<string, number> {
	const counts = new Map<string, number>();
	for (const component of registry?.components ?? []) {
		counts.set(component.kind, (counts.get(component.kind) ?? 0) + 1);
	}
	return counts;
}

export function hasRegistryComponent(registry: Registry | undefined, kind: string, name?: string): boolean {
	return (registry?.components ?? []).some((component) => {
		if (component.kind !== kind) return false;
		return name === undefined || component.name === name;
	});
}

export function formatHarnessRegistrySummary(view: HarnessRegistryView): string {
	if (view.error) {
		return `Harness registry unavailable: ${view.error}`;
	}

	const registry = view.registry;
	if (!registry) {
		return "Harness registry not loaded.";
	}

	const counts = [...countRegistryComponentsByKind(registry).entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([kind, count]) => `${kind}:${count}`)
		.join(", ");
	const pathLine = view.path ? `\nPath: ${view.path}` : "";
	const names = registry.components.map((component) => `${component.kind}/${component.name}`).join(", ");

	return `Harness registry: ${registry.name ?? "unnamed"} (${registry.components.length} components)\nKinds: ${
		counts || "none"
	}${pathLine}\nComponents: ${names || "none"}`;
}

export function formatHarnessRuntimeSummary(snapshot: HarnessRuntimeSnapshot): string {
	const activeTools = snapshot.tools.filter((tool) => tool.active).map((tool) => tool.name);
	const memoryRegistered = hasRegistryComponent(snapshot.registry.registry, "memory");
	const registryStatus = snapshot.registry.error
		? "unavailable"
		: `${snapshot.registry.registry?.components.length ?? 0} components`;
	const hookStatus = snapshot.activeHookEvents.length > 0 ? snapshot.activeHookEvents.join(", ") : "none";

	return [
		"Harness runtime",
		`Auto-compact: ${snapshot.autoCompact ? "enabled" : "disabled"}`,
		`Skill commands: ${snapshot.skillCommands ? "enabled" : "disabled"} (${snapshot.loadedSkills} skills loaded)`,
		`Tools: ${activeTools.length}/${snapshot.tools.length} active${
			activeTools.length > 0 ? ` (${activeTools.join(", ")})` : ""
		}`,
		`Hooks: ${snapshot.loadedExtensions} extensions loaded; active events: ${hookStatus}`,
		`Memory: ${memoryRegistered ? "registered; no AgentSession runtime switch yet" : "not registered"}`,
		`Registry: ${registryStatus}`,
	].join("\n");
}
