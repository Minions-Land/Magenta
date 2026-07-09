import type { Skill } from "../../../core/types/types.ts";
import type { FormatSkillsOptions, SystemPromptProviderContract } from "../HcpServer.ts";
import { formatSkillsForSystemPrompt } from "../HcpServer.ts";
import { loadSystemPromptDescriptor } from "./descriptor.ts";

export class SystemPromptProvider implements SystemPromptProviderContract {
	formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string {
		return formatSkillsForSystemPrompt(skills, options);
	}

	loadDescriptor(descriptorPath: string): ReturnType<SystemPromptProviderContract["loadDescriptor"]> {
		return loadSystemPromptDescriptor(descriptorPath);
	}
}
