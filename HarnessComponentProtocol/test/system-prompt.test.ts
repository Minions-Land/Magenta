import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../_magenta/env/pi/nodejs.ts";
import { loadSystemPromptDescriptor } from "../system-prompt/pi/descriptor.ts";
import { SystemPromptProvider } from "../system-prompt/pi/provider.ts";
import { buildSystemPrompt, formatSkillsForSystemPrompt } from "../system-prompt/pi/system-prompt.ts";

const visibleSkill = {
	name: "visible",
	description: "Use <this> & that",
	content: "visible content",
	filePath: "/skills/visible/SKILL.md",
};

const secondSkill = {
	name: "second",
	description: "Second skill",
	content: "second content",
	filePath: "/skills/second/SKILL.md",
};

const disabledSkill = {
	name: "hidden",
	description: "Hidden",
	content: "hidden content",
	filePath: "/skills/hidden/SKILL.md",
	disableModelInvocation: true,
};

describe("formatSkillsForSystemPrompt", () => {
	it("formats visible skills in order and skips model-disabled skills", () => {
		expect(formatSkillsForSystemPrompt([visibleSkill, disabledSkill, secondSkill])).toBe(
			`The following skills provide specialized instructions for specific tasks.
Use the read tool to load the full skill file when the task matches its description.
After loading a skill, follow its instructions precisely. Skills define mandatory workflows, constraints, and execution patterns that override default behavior.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>visible</name>
    <description>Use &lt;this&gt; &amp; that</description>
    <location>/skills/visible/SKILL.md</location>
  </skill>
  <skill>
    <name>second</name>
    <description>Second skill</description>
    <location>/skills/second/SKILL.md</location>
  </skill>
</available_skills>`,
		);
	});

	it("returns an empty string when no skills are model-visible", () => {
		expect(formatSkillsForSystemPrompt([disabledSkill])).toBe("");
	});

	it("escapes XML in all model-visible skill fields", () => {
		expect(
			formatSkillsForSystemPrompt([
				{
					name: "a&b",
					description: `Quote "double" and 'single'`,
					content: "content",
					filePath: '/skills/<bad>&"quote"/SKILL.md',
				},
			]),
		).toContain(
			"<name>a&amp;b</name>\n    <description>Quote &quot;double&quot; and &apos;single&apos;</description>\n    <location>/skills/&lt;bad&gt;&amp;&quot;quote&quot;/SKILL.md</location>",
		);
	});
});

describe("buildSystemPrompt", () => {
	const documentationPaths = {
		readmePath: "/magenta/README.md",
		docsPath: "/magenta/docs",
		examplesPath: "/magenta/examples",
	};

	it("builds the default coding and research prompt deterministically with a fixed date", () => {
		const options = {
			cwd: "C:\\work\\repo",
			currentDate: "2026-07-15",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			documentationPaths,
		};

		const first = buildSystemPrompt(options);
		const second = new SystemPromptProvider().buildSystemPrompt(options);

		expect(second).toBe(first);
		expect(first).toContain("expert coding and research agent");
		expect(first).toContain("Agent collaboration principles:");
		expect(first).toContain("verify interfaces instead of guessing them");
		expect(first).toContain("Resolve major ambiguities before implementation");
		expect(first).toContain("Reuse existing components and patterns");
		expect(first).toContain("Respect the repository architecture, the requested scope");
		expect(first).toContain("Validate in proportion to risk");
		expect(first).toContain("State uncertainty and blockers honestly");
		expect(first).toContain("small, reviewable steps that still produce an end-to-end functional slice");
		expect(first).toContain("Main documentation: /magenta/README.md");
		expect(first).toContain("Current date: 2026-07-15");
		expect(first).toContain("Current working directory: C:/work/repo");
		expect(first).not.toContain("Kiro, Claude, GPT, Gemini");
	});

	it("uses a custom prompt as the base while retaining ordered conditional operations and context", () => {
		const prompt = buildSystemPrompt({
			cwd: "/repo",
			currentDate: "2026-07-15",
			customPrompt: "CUSTOM IDENTITY",
			appendSystemPrompt: "HOST APPEND",
			selectedTools: ["bg_shell"],
			bundledPromptFeatures: { backgroundWork: true },
			documentationPaths,
			contextFiles: [{ path: "/repo/AGENTS.md", content: "PROJECT RULE" }],
		});

		expect(prompt).not.toContain("You are Magenta");
		expect(prompt).not.toContain("Available tools:");
		expect(prompt).not.toContain("Magenta documentation");
		expect(prompt).not.toContain("Agent collaboration principles:");
		expect(prompt).toContain("# Background Work");
		expect(prompt.indexOf("CUSTOM IDENTITY")).toBeLessThan(prompt.indexOf("HOST APPEND"));
		expect(prompt.indexOf("HOST APPEND")).toBeLessThan(prompt.indexOf("# Background Work"));
		expect(prompt.indexOf("# Background Work")).toBeLessThan(prompt.indexOf("<project_context>"));
		expect(prompt.indexOf("<project_context>")).toBeLessThan(prompt.indexOf("Current date: 2026-07-15"));
	});

	it("emits bundled background instructions only for active supported tools", () => {
		const base = { cwd: "/repo", currentDate: "2026-07-15", bundledPromptFeatures: { backgroundWork: true } };
		expect(buildSystemPrompt({ ...base, selectedTools: [] })).not.toContain("# Background Work");
		expect(
			buildSystemPrompt({ ...base, selectedTools: ["bg_shell"], bundledPromptFeatures: { backgroundWork: false } }),
		).not.toContain("# Background Work");

		const shellOnly = buildSystemPrompt({ ...base, selectedTools: ["bg_shell"] });
		expect(shellOnly).toContain("bg_shell action=start");
		expect(shellOnly).toContain("continue only non-overlapping independent work");
		expect(shellOnly).toContain("intentionally exposes no blocking wait action");
		expect(shellOnly).toContain("do not rerun the command, duplicate its purpose, or poll action=status");
		expect(shellOnly).toContain("activates a later turn");
		expect(shellOnly).not.toContain("action=wait");
		expect(shellOnly).not.toContain("regular bash tool");
		expect(shellOnly).not.toContain("sub_agent");
		expect(shellOnly).not.toContain("soft lease");

		const agentOnly = buildSystemPrompt({ ...base, selectedTools: ["sub_agent"] });
		expect(agentOnly).toContain("Use sub_agent for independent parallel analysis");
		expect(agentOnly).toContain("running event a soft lease");
		expect(agentOnly).toContain("do not duplicate the task");
		expect(agentOnly).toContain("Do not poll status for completion");
		expect(agentOnly).toContain("terminal result returns through external activation");
		expect(agentOnly).toContain("synthesize it and independently verify it");
		expect(agentOnly).not.toContain("bg_shell");
		expect(agentOnly).not.toContain("regular bash tool");
	});
});

describe("loadSystemPromptDescriptor", () => {
	it("loads harness module descriptors without content paths", async () => {
		const result = await loadSystemPromptDescriptor(join(process.cwd(), "system-prompt", "system-prompt.toml"));

		expect(result.diagnostics).toEqual([]);
		expect(result.descriptor).toMatchObject({
			kind: "system-prompt",
			name: "system-prompt",
			source: "pi",
			contentPath: undefined,
		});
	});

	it("resolves package-local content paths from system prompt descriptors", async () => {
		const root = await mkdtemp(join(tmpdir(), "magenta-system-prompt-"));
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile(
			"system-prompt/system-prompt.toml",
			`kind = "system-prompt"
name = "system-prompt"
source = "TestPackage"
content_path = "SYSTEM.md"
`,
		);
		await env.writeFile("system-prompt/SYSTEM.md", "Package prompt.");

		const result = await loadSystemPromptDescriptor(join(root, "system-prompt", "system-prompt.toml"));

		expect(result.diagnostics).toEqual([]);
		expect(result.descriptor).toMatchObject({
			kind: "system-prompt",
			name: "system-prompt",
			source: "TestPackage",
			contentPath: join(root, "system-prompt", "SYSTEM.md"),
		});
	});

	it("rejects descriptor-local symlinks that resolve outside the descriptor directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "magenta-system-prompt-symlink-"));
		try {
			const env = new NodeExecutionEnv({ cwd: root });
			await env.writeFile(
				"system-prompt/system-prompt.toml",
				`kind = "system-prompt"
name = "system-prompt"
content_path = "LINK.md"
`,
			);
			const outsidePath = join(root, "OUTSIDE.md");
			await writeFile(outsidePath, "Outside prompt.");
			await symlink(outsidePath, join(root, "system-prompt", "LINK.md"), "file");

			const result = await loadSystemPromptDescriptor(join(root, "system-prompt", "system-prompt.toml"));

			expect(result.descriptor?.contentPath).toBeUndefined();
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "system_prompt_descriptor_invalid",
					message: expect.stringContaining("escapes descriptor directory"),
				}),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
