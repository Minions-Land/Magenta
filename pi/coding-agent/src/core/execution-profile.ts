import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";

export const EXECUTION_PROFILES = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ExecutionProfile = ThinkingLevel | "ultra";

export interface HarnessCapabilitySettings {
	workflows?: boolean;
	teammates?: boolean;
}

export interface HarnessCapabilities {
	workflows: boolean;
	teammates: boolean;
}

export function isExecutionProfile(value: string): value is ExecutionProfile {
	return EXECUTION_PROFILES.includes(value as ExecutionProfile);
}

export function getAvailableExecutionProfiles(model?: Model<any>): ExecutionProfile[] {
	if (!model) return [...EXECUTION_PROFILES];
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return [...levels, "ultra"];
}

export function resolveExecutionProfile(model: Model<any> | undefined, profile: ExecutionProfile): ThinkingLevel {
	if (!model) return "off";
	if (profile !== "ultra") return clampThinkingLevel(model, profile) as ThinkingLevel;
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return levels.at(-1) ?? "off";
}

export function resolveHarnessCapabilities(
	profile: ExecutionProfile,
	settings?: HarnessCapabilitySettings,
	overrides?: HarnessCapabilitySettings,
): HarnessCapabilities {
	const enabledByProfile = profile === "ultra";
	return {
		workflows: overrides?.workflows ?? settings?.workflows ?? enabledByProfile,
		teammates: overrides?.teammates ?? settings?.teammates ?? enabledByProfile,
	};
}
