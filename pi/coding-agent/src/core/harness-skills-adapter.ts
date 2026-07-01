/**
 * Adapter that bridges pi's skills loading interface to the harness async abstraction.
 *
 * Architecture (mirrors the HCP/Magnet split studied in the Magenta repo): the harness provides
 * capability *primitives* — `loadSkills(env, dirs)` walks a directory, `loadSkillFile(env, path)`
 * loads a single `.md` file — both through the `ExecutionEnv` abstraction. The *policy* of how pi
 * discovers skills, classifies file-vs-directory paths, attaches provenance, and resolves name
 * collisions / symlink duplicates lives here in pi.
 *
 * pi's package-manager pre-discovers individual skill *file paths* (root `.md` files and nested
 * `SKILL.md`), so this adapter classifies each path via `env.fileInfo` and dispatches accordingly,
 * rather than handing everything to the directory-only harness `loadSkills`.
 */

import type { Skill as HarnessSkill, SkillDiagnostic } from "@magenta/harness";
import { loadSkillFile, loadSkills as loadSkillsFromHarness, NodeExecutionEnv } from "@magenta/harness";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories). */
	skillPaths: string[];
	/** Include default skills directories (agentDir/skills, cwd/.pi/skills). */
	includeDefaults: boolean;
}

export interface LoadSkillsResult {
	skills: HarnessSkill[];
	diagnostics: ResourceDiagnostic[];
}

/** Project config directory name (mirrors CONFIG_DIR_NAME). */
const CONFIG_DIR_NAME = ".pi";

/**
 * pi historically did not require a skill's name to match its parent directory: it supports flat
 * root `.md` files (e.g. `.pi/skills/foo.md`) as a documented convention. The harness enforces the
 * Agent-Skills "name must match parent directory" rule, which would warn on every such skill. We
 * drop only that specific diagnostic (matched via the stable `invalid_metadata` code plus the rule
 * text) so other metadata validations — invalid characters, length, hyphen rules — still surface.
 */
function isParentDirNameMismatch(d: SkillDiagnostic): boolean {
	return d.code === "invalid_metadata" && d.message.includes("does not match parent directory");
}

function toResourceDiagnostics(diagnostics: SkillDiagnostic[]): ResourceDiagnostic[] {
	return diagnostics
		.filter((d) => !isParentDirNameMismatch(d))
		.map((d) => ({ type: d.type, message: d.message, path: d.path }));
}

/**
 * Load skills from all configured paths using the harness async abstraction.
 *
 * Each path is classified through `env.fileInfo`: directories are walked by harness `loadSkills`,
 * `.md` files are loaded individually by harness `loadSkillFile`. Results are deduplicated by
 * canonical path (symlink dedup) and by name (collision diagnostics), preserving pi's original
 * `loadSkills` semantics.
 */
export async function loadSkills(options: LoadSkillsOptions): Promise<LoadSkillsResult> {
	const { cwd, agentDir, skillPaths, includeDefaults } = options;

	const env = new NodeExecutionEnv({ cwd });
	try {
		const dirs: string[] = [];
		if (includeDefaults) {
			dirs.push(`${agentDir}/skills`);
			dirs.push(`${cwd}/${CONFIG_DIR_NAME}/skills`);
		}

		const skillMap = new Map<string, HarnessSkill>();
		const realPathSet = new Set<string>();
		const diagnostics: ResourceDiagnostic[] = [];
		const collisionDiagnostics: ResourceDiagnostic[] = [];

		const addSkill = async (skill: HarnessSkill): Promise<void> => {
			const canonical = await env.canonicalPath(skill.filePath);
			const realPath = canonical.ok ? canonical.value : skill.filePath;

			// Skip silently if we've already loaded this exact file (via symlink).
			if (realPathSet.has(realPath)) return;

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
				return;
			}
			skillMap.set(skill.name, skill);
			realPathSet.add(realPath);
		};

		// Default directories: harness walks them.
		for (const dir of dirs) {
			const result = await loadSkillsFromHarness(env, dir);
			diagnostics.push(...toResourceDiagnostics(result.diagnostics));
			for (const skill of result.skills) await addSkill(skill);
		}

		// Explicit skill paths: classify each as file or directory.
		for (const rawPath of skillPaths) {
			const info = await env.fileInfo(rawPath);
			if (!info.ok) {
				if (info.error.code === "not_found") {
					diagnostics.push({ type: "warning", message: "skill path does not exist", path: rawPath });
				} else {
					diagnostics.push({ type: "warning", message: info.error.message, path: rawPath });
				}
				continue;
			}

			// fileInfo does not follow symlinks; resolve the target kind explicitly.
			let kind = info.value.kind;
			if (kind === "symlink") {
				const canonical = await env.canonicalPath(rawPath);
				if (canonical.ok) {
					const target = await env.fileInfo(canonical.value);
					if (target.ok) kind = target.value.kind;
				}
			}

			if (kind === "directory") {
				const result = await loadSkillsFromHarness(env, rawPath);
				diagnostics.push(...toResourceDiagnostics(result.diagnostics));
				for (const skill of result.skills) await addSkill(skill);
			} else if (kind === "file" && rawPath.endsWith(".md")) {
				const result = await loadSkillFile(env, rawPath);
				diagnostics.push(...toResourceDiagnostics(result.diagnostics));
				if (result.skill) await addSkill(result.skill);
			} else {
				diagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: rawPath });
			}
		}

		return {
			skills: Array.from(skillMap.values()),
			diagnostics: [...diagnostics, ...collisionDiagnostics],
		};
	} finally {
		await env.cleanup();
	}
}
