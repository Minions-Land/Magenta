/**
 * Skills type and formatting utilities.
 *
 * The actual skill loading is delegated to the harness async abstraction layer
 * (see harness-skills-adapter.ts). This module only re-exports the Skill type
 * (extended with pi-specific sourceInfo) and provides the formatSkillsForPrompt
 * utility for system prompt generation. The XML-formatting logic lives in the
 * harness (formatSkillsForSystemPrompt); pi injects its own intro wording and a
 * leading blank-line prefix (the block is appended inline to the system prompt).
 */
import type { Skill as BaseSkill } from "@magenta/harness";
import { formatSkillsForSystemPrompt } from "@magenta/harness";
import type { SourceInfo } from "./source-info.ts";

/** Pi's Skill type extends harness Skill with pi-specific fields. */
export interface Skill extends BaseSkill {
	/** Directory containing the skill file (for resolving relative paths). */
	baseDir: string;
	/** Source provenance information (user/project/extension/etc). */
	sourceInfo: SourceInfo;
}

/** Intro wording pi uses for the skills block (mentions the read tool explicitly). */
const PI_SKILLS_INTRO_LINES = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
];

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard (delegated to the harness).
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	return formatSkillsForSystemPrompt(skills, {
		prefix: "\n\n",
		introLines: PI_SKILLS_INTRO_LINES,
	});
}
