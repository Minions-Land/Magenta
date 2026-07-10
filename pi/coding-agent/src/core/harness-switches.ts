import { HCP_MAGNETS, HCP_SERVERS, type HcpClient } from "@magenta/harness";
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

export type HarnessSourceView = {
	source: string;
	status: "active" | "selected" | "available";
	selected: boolean;
	active: boolean;
	descriptorPath: string;
};

export type HarnessComponentView = {
	id: string;
	module: string;
	kind: string;
	name: string;
	product: "tool" | "capability" | "resource";
	description?: string;
	status: "active" | "selected" | "available";
	descriptorPath: string;
	sources: HarnessSourceView[];
};

export type HarnessComponentsView = {
	components: HarnessComponentView[];
};

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
	harnessPackages: string[];
	packageToolCount: number;
	packageDiagnosticCount: number;
	activeHookEvents: string[];
	components: HarnessComponentsView;
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
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildHarnessComponentsView(hcp?: HcpClient): HarnessComponentsView {
	const descriptions = new Map(hcp?.describeAll().map((description) => [description.target, description]) ?? []);
	const components = new Map<string, HarnessComponentView>();
	for (const row of HCP_MAGNETS) {
		const id = `${row.kind}/${row.name}`;
		const target =
			row.product === "capability"
				? `capability:${row.slot}`
				: row.product === "tool"
					? `tool:${row.name}`
					: `${row.kind}:${row.name}`;
		const description = descriptions.get(target);
		const describedSource = description?.metadata?.source;
		const active =
			typeof describedSource === "string"
				? describedSource === row.source
				: Boolean(hcp?.resolveModule(row.module)) && row.selected;
		const source: HarnessSourceView = {
			source: row.source,
			status: active ? "active" : row.selected ? "selected" : "available",
			selected: row.selected,
			active,
			descriptorPath: row.descriptorPath,
		};
		const existing = components.get(id);
		if (existing) {
			existing.sources.push(source);
			if (source.status === "active") existing.status = "active";
			else if (source.status === "selected" && existing.status === "available") existing.status = "selected";
			continue;
		}
		const HcpServer = HCP_SERVERS.get(row.module);
		const serverDescription = HcpServer ? new HcpServer().description : undefined;
		components.set(id, {
			id,
			module: row.module,
			kind: row.kind,
			name: row.name,
			product: row.product,
			description: description?.description ?? serverDescription,
			status: source.status,
			descriptorPath: row.descriptorPath,
			sources: [source],
		});
	}
	return {
		components: [...components.values()].sort((left, right) => left.id.localeCompare(right.id)),
	};
}

export function countHarnessComponentsByKind(view: HarnessComponentsView): Map<string, number> {
	const counts = new Map<string, number>();
	for (const component of view.components) {
		counts.set(component.kind, (counts.get(component.kind) ?? 0) + 1);
	}
	return counts;
}

export function hasHarnessComponent(view: HarnessComponentsView, kind: string, name?: string): boolean {
	return view.components.some((component) => {
		if (component.kind !== kind) return false;
		return name === undefined || component.name === name;
	});
}

export function formatHarnessComponentsSummary(view: HarnessComponentsView): string {
	const counts = [...countHarnessComponentsByKind(view).entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([kind, count]) => `${kind}:${count}`)
		.join(", ");
	const names = view.components.map((component) => component.id).join(", ");
	return `Harness components (${view.components.length})\nKinds: ${counts || "none"}\nComponents: ${names || "none"}`;
}

export function formatHarnessRuntimeSummary(snapshot: HarnessRuntimeSnapshot): string {
	const activeTools = snapshot.tools.filter((tool) => tool.active).map((tool) => tool.name);
	const memoryAvailable = hasHarnessComponent(snapshot.components, "memory");
	const activeComponents = snapshot.components.components.filter((component) => component.status === "active").length;
	const hookStatus = snapshot.activeHookEvents.length > 0 ? snapshot.activeHookEvents.join(", ") : "none";
	const packageStatus =
		snapshot.harnessPackages.length > 0
			? `${snapshot.harnessPackages.join(", ")}; tools:${snapshot.packageToolCount}; diagnostics:${snapshot.packageDiagnosticCount}`
			: "none";

	return [
		"Harness runtime",
		`Auto-compact: ${snapshot.autoCompact ? "enabled" : "disabled"}`,
		`Skill commands: ${snapshot.skillCommands ? "enabled" : "disabled"} (${snapshot.loadedSkills} skills loaded)`,
		`Tools: ${activeTools.length}/${snapshot.tools.length} active${
			activeTools.length > 0 ? ` (${activeTools.join(", ")})` : ""
		}`,
		`Packages: ${packageStatus}`,
		`Hooks: ${snapshot.loadedExtensions} extensions loaded; active events: ${hookStatus}`,
		`Memory: ${memoryAvailable ? "available" : "not declared"}`,
		`Components: ${activeComponents}/${snapshot.components.components.length} active`,
	].join("\n");
}
