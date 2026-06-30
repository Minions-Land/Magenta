/**
 * Adapter that bridges pi's skills loading interface to the harness async abstraction.
 *
 * Architecture: Per the Magenta architecture docs, all harness modules depend on abstract
 * interfaces (ExecutionEnv) rather than concrete implementations. This adapter constructs
 * the NodeExecutionEnv Magnet (node.js fs implementation) and calls harness loadSkills.
 *
 * The harness Skill type is simpler (no baseDir/sourceInfo); pi's resource-loader adds
 * those via post-processing after loading (already happening at L627-633).
 */
import { NodeExecutionEnv } from "@magenta/harness";
import type { Skill as HarnessSkill, SkillDiagnostic } from "@magenta/harness";
import { loadSkills as loadSkillsFromHarness } from "@magenta/harness";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

export interface LoadSkillsResult {
	skills: HarnessSkill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load skills from all configured locations using the harness async abstraction.
 *
 * Maps harness SkillDiagnostic → pi ResourceDiagnostic (harness has stable `code` field;
 * pi doesn't but accepts plain diagnostics).
 */
export async function loadSkills(options: LoadSkillsOptions): Promise<LoadSkillsResult> {
	const { cwd, agentDir, skillPaths, includeDefaults } = options;

	// Construct the NodeExecutionEnv Magnet (node.js fs implementation)
	const env = new NodeExecutionEnv({ cwd });

	// Build the list of directories to scan
	const dirs: string[] = [];
	if (includeDefaults) {
		dirs.push(`${agentDir}/skills`); // user skills
		dirs.push(`${cwd}/.pi/skills`); // project skills (CONFIG_DIR_NAME = ".pi")
	}
	dirs.push(...skillPaths);

	// Call harness loadSkills (async, returns Result-wrapped skills)
	const result = await loadSkillsFromHarness(env, dirs);

	// Map harness diagnostics → pi ResourceDiagnostic
	const diagnostics: ResourceDiagnostic[] = result.diagnostics.map((d: SkillDiagnostic) => ({
		type: d.type,
		message: d.message,
		path: d.path,
	}));

	return { skills: result.skills, diagnostics };
}
