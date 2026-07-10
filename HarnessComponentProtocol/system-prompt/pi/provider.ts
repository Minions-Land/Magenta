import type { Skill } from "../../_magenta/types/types.ts";
import type { FormatSkillsOptions } from "../HcpServer.ts";
import { formatSkillsForSystemPrompt } from "../HcpServer.ts";
import { loadSystemPromptDescriptor } from "./descriptor.ts";

export class SystemPromptProvider {
	formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string {
		return formatSkillsForSystemPrompt(skills, options);
	}

	loadDescriptor(descriptorPath: string): ReturnType<typeof loadSystemPromptDescriptor> {
		return loadSystemPromptDescriptor(descriptorPath);
	}
}
