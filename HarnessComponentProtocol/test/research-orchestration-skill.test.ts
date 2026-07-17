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

	it("treats statuses as authoritative and currentId as optional foreground focus", () => {
		const skill = readSkillFile("SKILL.md");

		expect(skill).toContain("node `status` values as the authoritative progress state");
		expect(skill).toContain("Multiple nodes may be `in_progress` during fan-out");
		expect(skill).toContain("`currentId` is only an optional foreground focus");
		expect(skill).toContain("set it to `null` when no single work item owns foreground attention");
		expect(skill).not.toContain("Set one current item");
	});

	it("defines delegation ownership as acquire and release soft leases", () => {
		const skill = readSkillFile("SKILL.md");

		expect(skill).toContain("Delegation uses **soft leases**, not runtime locks");
		expect(skill).toContain("successful `sub_agent` or workflow dispatch leases its delegated analysis scope");
		expect(skill).toContain("assignment must name owned files or globs");
		expect(skill).toContain('workspace="worktree"');
		expect(skill).toContain("matching structured terminal receipt");
		expect(skill).toContain("main agent may advance only non-overlapping Todo work");
		expect(skill).toContain("A teammate becoming idle does not release");
		expect(skill).toContain("reclaim the scope only after its terminal event or receipt arrives");
		expect(skill).toContain("synthesize the result and independently verify it");
		expect(skill).toContain("Do not add a Todo owner schema or a separate lease registry");
		expect(skill).toContain("blocks `bash`");
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
