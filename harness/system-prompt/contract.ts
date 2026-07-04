import type { TomlTable } from "../hcp-client/registry/registry.ts";
import type { Skill } from "../types/types.ts";

/** Options to customize the skills system-prompt block wording without changing its XML structure. */
export interface FormatSkillsOptions {
	/** Text prepended before the intro block. Default: "" (no prefix). */
	prefix?: string;
	/** Intro lines describing how to use skills. Default: the standard Agent-Skills wording. */
	introLines?: string[];
}

export type SystemPromptDescriptorDiagnosticCode =
	| "system_prompt_descriptor_read_failed"
	| "system_prompt_descriptor_invalid";

export interface SystemPromptDescriptorDiagnostic {
	type: "warning" | "error";
	code: SystemPromptDescriptorDiagnosticCode;
	message: string;
	path: string;
}

export interface SystemPromptDescriptor {
	kind: "system-prompt" | "append-system-prompt";
	name: string;
	description?: string;
	source?: string;
	contentPath?: string;
	descriptorPath: string;
	raw: TomlTable;
}

export interface SystemPromptProviderContract {
	formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string;
	loadDescriptor(
		descriptorPath: string,
	): Promise<{ descriptor?: SystemPromptDescriptor; diagnostics: SystemPromptDescriptorDiagnostic[] }>;
}

const DEFAULT_SKILLS_INTRO_LINES = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load the full skill file when the task matches its description.",
	"After loading a skill, follow its instructions precisely. Skills define mandatory workflows, constraints, and execution patterns that override default behavior.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
];

export function formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const introLines = options?.introLines ?? DEFAULT_SKILLS_INTRO_LINES;
	const lines = [...introLines, "", "<available_skills>"];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return (options?.prefix ?? "") + lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
