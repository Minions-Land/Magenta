import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(HARNESS_ROOT, "..");
const SKILL_ROOT = resolve(HARNESS_ROOT, "skills", "research-orchestration", "pi");

function readSkillFile(relativePath: string): string {
	return readFileSync(resolve(SKILL_ROOT, relativePath), "utf8");
}

describe("research-orchestration state contract", () => {
	it("makes Todo the only planning and progress source", () => {
		const skill = readSkillFile("SKILL.md");

		expect(skill).toContain("Todo is the single source of truth for planning and progress.");
		expect(skill).toContain("Top-level `action` is only `get` or `apply`.");
		expect(skill).toContain("belong only in `operations[].op`");
		expect(skill).toContain(
			"Do not create or maintain `plan.md`, `progress.md`, `contract.md`, `reflection.md`, a second checklist",
		);
		expect(skill).not.toContain("Todo is optional");
		expect(skill).not.toContain("State lives on disk");
	});

	it("does not ship file-based planning templates", () => {
		expect(existsSync(resolve(SKILL_ROOT, "assets", "templates"))).toBe(false);
	});

	it("keeps the reference principles aligned with the single-ledger contract", () => {
		const principles = readSkillFile("assets/references/loop-principles.md");

		expect(principles).toContain("The Todo is the only planning and progress record");
		expect(principles).toContain("Do not mirror that state into `plan.md`");
	});

	it("cleans copied skill assets before binary and release staging", () => {
		const codingAgentPackage = JSON.parse(
			readFileSync(resolve(REPO_ROOT, "pi", "coding-agent", "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		const copyScript = codingAgentPackage.scripts?.["copy-binary-assets"] ?? "";
		const cleanIndex = copyScript.indexOf("shx rm -rf");
		const skillsCleanIndex = copyScript.indexOf("dist/skills", cleanIndex);
		const skillsCopyIndex = copyScript.indexOf("../../HarnessComponentProtocol/skills/*");

		expect(cleanIndex).toBeGreaterThanOrEqual(0);
		expect(skillsCleanIndex).toBeGreaterThan(cleanIndex);
		expect(skillsCopyIndex).toBeGreaterThan(skillsCleanIndex);
	});
});
