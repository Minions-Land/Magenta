import { resolve } from "path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { loadSkills } from "../src/core/harness-skills-adapter.ts";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");
const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

function hasMessage(diagnostics: ResourceDiagnostic[], substring: string): boolean {
	return diagnostics.some((d) => d.message.includes(substring));
}

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		content: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

/** Load a single fixture directory through the adapter, with defaults disabled. */
function loadFixture(dir: string) {
	return loadSkills({ cwd: emptyCwd, agentDir: emptyAgentDir, skillPaths: [dir], includeDefaults: false });
}

describe("skills", () => {
	describe("loadSkills from a directory", () => {
		it("should load a valid skill", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "valid-skill"));
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow names that don't match parent directory", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "name-mismatch"));
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			// pi historically allowed name/parent-dir mismatches; the adapter filters that warning.
			expect(hasMessage(diagnostics, "does not match parent directory")).toBe(false);
		});

		it("should warn when name contains invalid characters", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "invalid-name-chars"));
			expect(skills).toHaveLength(1);
			expect(hasMessage(diagnostics, "invalid characters")).toBe(true);
		});

		it("should warn when name exceeds 64 characters", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "long-name"));
			expect(skills).toHaveLength(1);
			expect(hasMessage(diagnostics, "exceeds 64 characters")).toBe(true);
		});

		it("should warn and skip skill when description is missing", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "missing-description"));
			expect(skills).toHaveLength(0);
			expect(hasMessage(diagnostics, "description is required")).toBe(true);
		});

		it("should ignore unknown frontmatter fields", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "unknown-field"));
			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "nested"));
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "root-skill-preferred"));
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});
		// MORE_DIR_TESTS
		it("should skip files without frontmatter", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "no-frontmatter"));
			expect(skills).toHaveLength(0);
			expect(hasMessage(diagnostics, "description is required")).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "invalid-yaml"));
			expect(skills).toHaveLength(0);
			expect(diagnostics.length).toBeGreaterThan(0);
		});

		it("should preserve multiline descriptions from YAML", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "multiline-description"));
			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "consecutive-hyphens"));
			expect(skills).toHaveLength(1);
			expect(hasMessage(diagnostics, "consecutive hyphens")).toBe(true);
		});

		it("should load all skills from fixture directory", async () => {
			const { skills } = await loadFixture(fixturesDir);
			// All skills with descriptions load (even with warnings); missing-description and
			// no-frontmatter are skipped.
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", async () => {
			const { skills, diagnostics } = await loadFixture("/non/existent/path");
			expect(skills).toHaveLength(0);
			// A missing explicit skill path yields a "does not exist" warning.
			expect(hasMessage(diagnostics, "does not exist")).toBe(true);
		});

		it("should use parent directory name when name not in frontmatter", async () => {
			const { skills } = await loadFixture(resolve(fixturesDir, "valid-skill"));
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", async () => {
			const { skills, diagnostics } = await loadFixture(resolve(fixturesDir, "disable-model-invocation"));
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			expect(hasMessage(diagnostics, "unknown frontmatter field")).toBe(false);
		});

		it("should default disableModelInvocation to false when not specified", async () => {
			const { skills } = await loadFixture(resolve(fixturesDir, "valid-skill"));
			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});
	});
	// MORE_GROUPS

	describe("loadSkills with options", () => {
		it("should load from explicit skillPaths", async () => {
			const { skills, diagnostics } = await loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [resolve(fixturesDir, "valid-skill")],
				includeDefaults: false,
			});
			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", async () => {
			const { skills, diagnostics } = await loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: false,
			});
			expect(skills).toHaveLength(0);
			expect(hasMessage(diagnostics, "does not exist")).toBe(true);
		});

		it("should load a single .md file path directly", async () => {
			const { skills, diagnostics } = await loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [resolve(fixturesDir, "valid-skill", "SKILL.md")],
				includeDefaults: false,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep the first skill", async () => {
			const { skills, diagnostics } = await loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [resolve(collisionFixturesDir, "first"), resolve(collisionFixturesDir, "second")],
				includeDefaults: false,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("calendar");
			const collisions = diagnostics.filter((d) => d.type === "collision");
			expect(collisions).toHaveLength(1);
			expect(collisions[0].collision?.name).toBe("calendar");
		});

		it("preserves the collision loser in `shadowed` rather than discarding it", async () => {
			const { skills, shadowed } = await loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [resolve(collisionFixturesDir, "first"), resolve(collisionFixturesDir, "second")],
				includeDefaults: false,
			});
			expect(skills).toHaveLength(1);
			expect(shadowed).toHaveLength(1);
			expect(shadowed[0].name).toBe("calendar");
			// The winner and loser come from different fixture directories.
			expect(shadowed[0].filePath).not.toBe(skills[0].filePath);
		});

		it("returns an empty `shadowed` list when there are no collisions", async () => {
			const { shadowed } = await loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [resolve(collisionFixturesDir, "first")],
				includeDefaults: false,
			});
			expect(shadowed).toEqual([]);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			expect(formatSkillsForPrompt([])).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];
			const result = formatSkillsForPrompt(skills);
			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];
			const result = formatSkillsForPrompt(skills);
			const introText = result.substring(0, result.indexOf("<available_skills>"));
			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use the read tool to load a skill's file");
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];
			const result = formatSkillsForPrompt(skills);
			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];
			const result = formatSkillsForPrompt(skills);
			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];
			const result = formatSkillsForPrompt(skills);
			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];
			expect(formatSkillsForPrompt(skills)).toBe("");
		});
	});
});
