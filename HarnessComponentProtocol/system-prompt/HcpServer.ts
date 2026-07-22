import type { Skill } from "../_magenta/types/types.ts";
import type { TomlTable } from "../_magenta/utils/pi/toml.ts";

export class HcpServer {
	readonly moduleName = "system-prompt";
	readonly description = "Deterministic system prompt composition, descriptor loading, and skill formatting.";
}

/** Options to customize the skills system-prompt block wording without changing its XML structure. */
export type FormatSkillsOptions = {
	/** Text prepended before the intro block. Default: "" (no prefix). */
	prefix?: string;
	/** Intro lines describing how to use skills. Default: the standard Agent-Skills wording. */
	introLines?: string[];
};

/** Host-resolved locations used only by the default Magenta documentation section. */
export type SystemPromptDocumentationPaths = {
	readmePath: string;
	docsPath: string;
	examplesPath: string;
};

/** Bundled operational prompt fragments enabled by the host's resource policy. */
export type SystemPromptBundledFeatures = {
	backgroundWork?: boolean;
};

/** Complete input to the selected system-prompt Capability. */
export type BuildSystemPromptOptions = {
	/** Custom base prompt. Replaces the default identity, tools, guidelines, and documentation sections. */
	customPrompt?: string;
	/** Active tools. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default prompt guidelines. */
	promptGuidelines?: string[];
	/** Host-selected prompt content appended after the base prompt. */
	appendSystemPrompt?: string;
	/** Working directory displayed at the end of the prompt. */
	cwd: string;
	/** Pre-loaded project context files, in host precedence order. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills, in host precedence order. */
	skills?: Skill[];
	/** Host-resolved documentation paths. Omit to suppress the default documentation section. */
	documentationPaths?: SystemPromptDocumentationPaths;
	/** Host-enabled bundled fragments. Fragments are also gated by the corresponding active tools. */
	bundledPromptFeatures?: SystemPromptBundledFeatures;
	/** Optional date to display as YYYY-MM-DD. Omit it to keep the default prompt stable across days. */
	currentDate?: string | Date;
};

export type SystemPromptDescriptorDiagnosticCode =
	| "system_prompt_descriptor_read_failed"
	| "system_prompt_descriptor_invalid";

export type SystemPromptDescriptorDiagnostic = {
	type: "warning" | "error";
	code: SystemPromptDescriptorDiagnosticCode;
	message: string;
	path: string;
};

export type SystemPromptDescriptor = {
	kind: "system-prompt" | "append-system-prompt";
	name: string;
	description?: string;
	source?: string;
	contentPath?: string;
	descriptorPath: string;
	raw: TomlTable;
};

export type SystemPromptProvider = {
	buildSystemPrompt(options: BuildSystemPromptOptions): string;
	formatSkillsForSystemPrompt(skills: Skill[], options?: FormatSkillsOptions): string;
	loadDescriptor(
		descriptorPath: string,
	): Promise<{ descriptor?: SystemPromptDescriptor; diagnostics: SystemPromptDescriptorDiagnostic[] }>;
};
