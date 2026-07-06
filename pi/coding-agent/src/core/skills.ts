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
import { type Skill as BaseSkill, formatSkillsForSystemPrompt } from "@magenta/harness";
import type { SourceInfo } from "./source-info.ts";

/** Pi's Skill type extends harness Skill with pi-specific fields. */
export interface Skill extends BaseSkill {
	/** Directory containing the skill file (for resolving relative paths). */
	baseDir: string;
	/** Source provenance information (user/project/extension/etc). */
	sourceInfo: SourceInfo;
	/**
	 * Fully-qualified `<source>:<name>` identifier used to disambiguate skills that share a bare
	 * `name` across sources/packages. Populated by the resource loader for every skill it loads; for
	 * a skill with no collision it is simply an alternative handle, and the bare `name` remains the
	 * primary lookup key. Optional so SDK/test callers can construct `Skill` objects inline without it.
	 */
	qualifiedName?: string;
	/**
	 * True when this skill lost a name collision and is therefore excluded from the model-visible
	 * listing. It stays invocable via its {@link qualifiedName} through `/skill:<source>:<name>`.
	 *
	 * This is the common and most useful case: package skills carry a `harness:<packageId>:<profile>`
	 * source, so a package skill colliding with a local one — or two packages colliding — get distinct
	 * qualified names and both stay reachable. The only unaddressable collision is two skills sharing
	 * the *same* source (e.g. two filesystem-local skills), which share a qualified name; there the
	 * winner shadows the loser under both handles.
	 */
	shadowed?: boolean;
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
