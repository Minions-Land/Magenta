import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../core/env/pi/nodejs.ts";
import { loadSystemPromptDescriptor } from "../modules/system-prompt/pi/descriptor.ts";
import { formatSkillsForSystemPrompt } from "../modules/system-prompt/pi/system-prompt.ts";

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

describe("loadSystemPromptDescriptor", () => {
	it("loads harness module descriptors without content paths", async () => {
		const result = await loadSystemPromptDescriptor(
			join(process.cwd(), "modules", "system-prompt", "system-prompt.toml"),
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.descriptor).toMatchObject({
			kind: "system-prompt",
			name: "system-prompt",
			source: "Magenta",
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
});
