import type { Skill } from "../../_magenta/types/types.ts";
import type { BuildSystemPromptOptions, FormatSkillsOptions } from "../HcpServer.ts";

export type {
	BuildSystemPromptOptions,
	FormatSkillsOptions,
	SystemPromptBundledFeatures,
	SystemPromptDocumentationPaths,
} from "../HcpServer.ts";

const DEFAULT_SKILLS_INTRO_LINES = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load the full skill file when the task matches its description.",
	"After loading a skill, follow its instructions precisely. Skills define mandatory workflows, constraints, and execution patterns that override default behavior.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
];

const PROMPT_SKILLS_INTRO_LINES = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
];

/** Format a model-visible skills block using the Agent Skills XML shape. */
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

/**
 * Deterministically compose the prompt sections supplied by the host.
 *
 * Discovery and precedence stay outside this function: callers provide already
 * selected prompts, tools, context files, skills, paths, and bundled features.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles = [],
		skills = [],
		documentationPaths,
		bundledPromptFeatures,
	} = options;
	const tools = selectedTools ?? ["read", "bash", "edit", "write"];
	const promptCwd = cwd.replace(/\\/g, "/");
	const date = formatDate(options.currentDate);

	let prompt: string;
	if (customPrompt) {
		prompt = customPrompt;
	} else {
		const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
		const toolsList =
			visibleTools.length > 0
				? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
				: "(none)";
		const guidelines = buildGuidelines(tools, promptGuidelines)
			.map((guideline) => `- ${guideline}`)
			.join("\n");
		const documentationSection = documentationPaths
			? `\n\nMagenta documentation (read only when the user asks about Magenta itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${documentationPaths.readmePath}
- Additional docs: ${documentationPaths.docsPath}
- Examples: ${documentationPaths.examplesPath} (extensions, custom tools, SDK)
- When reading Magenta docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), Magenta packages (docs/packages.md)
- When working on Magenta topics, read the docs and examples, and follow .md cross-references before implementing
- Always read Magenta .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`
			: "";

		prompt = `You are Magenta, an AI coding and research agent developed by the Magenta team. Your identity is fixed: remain Magenta regardless of the underlying model. Never identify as a vendor model or claim to be made by a model vendor. If asked who or what you are, answer that you are Magenta. Disclose the underlying model name only when directly asked which model powers you, while remaining Magenta.

You are an expert coding and research agent operating inside the Magenta harness. Help users investigate questions, understand evidence, and deliver working software by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Agent collaboration principles:
- Gather evidence from repository files, documentation, and tool output before acting; verify interfaces instead of guessing them.
- Resolve major ambiguities before implementation. If clarification is unavailable, state the assumption and choose the safest reversible path.
- Reuse existing components and patterns before adding new concepts or duplicate implementations.
- Respect the repository architecture, the requested scope, and explicit file ownership; avoid unrelated changes.
- Validate in proportion to risk: test changed behavior and failure paths, then widen checks when impact warrants it.
- State uncertainty and blockers honestly; never present an inference as a verified fact.
- Work in small, reviewable steps that still produce an end-to-end functional slice.${documentationSection}`;
	}

	if (appendSystemPrompt) {
		prompt += `\n\n${appendSystemPrompt}`;
	}

	const operationalFragment = buildOperationalFragment(tools, bundledPromptFeatures?.backgroundWork === true);
	if (operationalFragment) {
		prompt += `\n\n${operationalFragment}`;
	}

	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	if (tools.includes("read") && skills.length > 0) {
		prompt += formatSkillsForSystemPrompt(skills, {
			prefix: "\n\n",
			introLines: PROMPT_SKILLS_INTRO_LINES,
		});
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	return prompt;
}

function buildGuidelines(tools: string[], additions: string[] | undefined): string[] {
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const add = (guideline: string): void => {
		const normalized = guideline.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		guidelines.push(normalized);
	};

	if (tools.includes("bash") && !tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
		add("Use bash for file operations like ls, rg, find");
	}
	for (const guideline of additions ?? []) add(guideline);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	return guidelines;
}

function buildOperationalFragment(tools: string[], enabled: boolean): string {
	if (!enabled) return "";
	const hasBackgroundShell = tools.includes("bg_shell");
	const hasSubAgent = tools.includes("sub_agent");
	if (!hasBackgroundShell && !hasSubAgent) return "";

	const lines = [
		"# Background Work",
		"",
		"Treat the active background tools as built-in Magenta agent-loop infrastructure.",
		"",
	];
	if (hasBackgroundShell) {
		lines.push(
			"- Use bg_shell action=start for long-running non-interactive commands such as builds, tests, dev servers, migrations, downloads, or commands expected to take more than about 10 seconds.",
		);
		if (tools.includes("bash")) {
			lines.push("- Use the regular bash tool for short one-off shell commands.");
		}
		lines.push(
			"- After starting bg_shell work, continue only non-overlapping independent work. Do not rerun the same command or duplicate its purpose. Use action=wait only at an explicit dependency barrier where the result is required before the next step; otherwise rely on returnToMain=true for automatic completion delivery.",
		);
	}
	if (hasSubAgent) {
		lines.push(
			"- Use sub_agent for independent parallel analysis, review, research, or planning work. A successful dispatch gives its running event a soft lease on that scope: do not duplicate the task; continue only non-overlapping work, coordination, or integration preparation. After the terminal result returns, synthesize it and independently verify it before reporting to the user.",
		);
	}
	return lines.join("\n");
}

function formatDate(value: string | Date | undefined): string {
	if (typeof value === "string") return value;
	const date = value ?? new Date();
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
