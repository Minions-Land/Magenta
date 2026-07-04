import type { FormatSkillsOptions, SystemPromptProviderContract } from "../contract.ts";
import { formatSkillsForSystemPrompt } from "../contract.ts";
import type { Skill } from "../../types/types.ts";
import { loadSystemPromptDescriptor } from "./descriptor.ts";

export class SystemPromptProvider implements SystemPromptProviderContract {
	formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string {
		return formatSkillsForSystemPrompt(skills, options);
	}

	loadDescriptor(descriptorPath: string): ReturnType<SystemPromptProviderContract["loadDescriptor"]> {
		return loadSystemPromptDescriptor(descriptorPath);
	}
}
