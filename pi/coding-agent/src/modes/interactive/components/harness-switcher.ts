import { type Component, Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { HarnessRuntimeSnapshot } from "../../../core/harness-switches.ts";
import { getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface HarnessSwitcherCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onSkillCommandsChange: (enabled: boolean) => void;
	onToolChange: (name: string, enabled: boolean) => void;
	onShowRegistry: () => void;
	onShowHooks: () => void;
	onShowMemory: () => void;
	onCancel: () => void;
}

function boolValue(enabled: boolean): string {
	return enabled ? "true" : "false";
}

function registryValue(snapshot: HarnessRuntimeSnapshot): string {
	if (snapshot.registry.error) return "unavailable";
	return `${snapshot.registry.registry?.components.length ?? 0} components`;
}

function memoryValue(snapshot: HarnessRuntimeSnapshot): string {
	const registered = snapshot.registry.registry?.components.some((component) => component.kind === "memory") ?? false;
	return registered ? "registered" : "not registered";
}

export class HarnessSwitcherComponent extends Container {
	private settingsList: SettingsList;

	constructor(snapshot: HarnessRuntimeSnapshot, callbacks: HarnessSwitcherCallbacks) {
		super();

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Harness compaction switch consumed by AgentSession before overflow/threshold compaction.",
				currentValue: boolValue(snapshot.autoCompact),
				values: ["true", "false"],
			},
			{
				id: "skill-commands",
				label: "Skill commands",
				description: "Expose loaded Harness skills as /skill:name slash commands.",
				currentValue: boolValue(snapshot.skillCommands),
				values: ["true", "false"],
			},
			{
				id: "registry",
				label: "Registry",
				description: "Print the loaded harness.toml component summary.",
				currentValue: registryValue(snapshot),
				values: [registryValue(snapshot)],
			},
			{
				id: "hooks",
				label: "Hooks",
				description: "Print extension hook/event wiring currently active in this AgentSession.",
				currentValue: `${snapshot.activeHookEvents.length} events`,
				values: [`${snapshot.activeHookEvents.length} events`],
			},
			{
				id: "memory",
				label: "Memory",
				description: "Print memory component status. Registered memory is not yet an AgentSession runtime switch.",
				currentValue: memoryValue(snapshot),
				values: [memoryValue(snapshot)],
			},
			...snapshot.tools.map((tool) => ({
				id: `tool:${tool.name}`,
				label: `Tool ${tool.name}`,
				description: `${tool.description ?? "No description"} (source: ${tool.source})`,
				currentValue: boolValue(tool.active),
				values: ["true", "false"],
			})),
		];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Harness")), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Switches below are backed by the current Magenta3 runtime; loop mode is unchanged."),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			items,
			12,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onSkillCommandsChange(newValue === "true");
						break;
					case "registry":
						callbacks.onShowRegistry();
						break;
					case "hooks":
						callbacks.onShowHooks();
						break;
					case "memory":
						callbacks.onShowMemory();
						break;
					default:
						if (id.startsWith("tool:")) {
							callbacks.onToolChange(id.slice("tool:".length), newValue === "true");
						}
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): Component {
		return this.settingsList;
	}
}
