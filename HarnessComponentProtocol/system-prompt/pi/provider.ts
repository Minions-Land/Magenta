import type { Skill } from "../../_magenta/types/types.ts";
import type { BuildSystemPromptOptions, FormatSkillsOptions } from "../HcpServer.ts";
import { loadSystemPromptDescriptor } from "./descriptor.ts";
import { buildSystemPrompt, formatSkillsForSystemPrompt } from "./system-prompt.ts";

export class SystemPromptProvider {
	buildSystemPrompt(options: BuildSystemPromptOptions): string {
		return buildSystemPrompt(options);
	}

	formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string {
		return formatSkillsForSystemPrompt(skills, options);
	}

	loadDescriptor(descriptorPath: string): ReturnType<typeof loadSystemPromptDescriptor> {
		return loadSystemPromptDescriptor(descriptorPath);
	}
}
