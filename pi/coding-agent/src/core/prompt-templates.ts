/**
 * Adapter that bridges pi's prompt-template loading interface to the harness async abstraction.
 *
 * Architecture (mirrors the HCP/Magnet split and the skills adapter): the harness provides the
 * capability *primitives* — `loadPromptTemplates(env, paths)` and `loadSourcedPromptTemplates(...)`
 * walk directories / load `.md` files through the `ExecutionEnv` abstraction, and the pure
 * `parseCommandArgs` / `substituteArgs` / `expandPromptTemplate` helpers. The *policy* of how pi
 * discovers templates (default dirs, provenance / `sourceInfo` classification) lives here in pi.
 *
 * pi's `PromptTemplate` extends the harness template with a required `sourceInfo` (provenance) and a
 * required `filePath`; the harness loader already populates `filePath` and `argumentHint`, so this
 * adapter only injects `sourceInfo` via the `mapPromptTemplate` hook (the Magnet seam).
 */
import type { PromptTemplate as HarnessPromptTemplate } from "@magenta/harness";
import { loadSourcedPromptTemplates, NodeExecutionEnv } from "@magenta/harness";
import { join, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

// Re-export the pure helpers from the harness so existing pi importers keep stable import paths.
export {
	expandPromptTemplate,
	formatPromptTemplateInvocation,
	parseCommandArgs,
	substituteArgs,
} from "@magenta/harness";

/**
 * Represents a prompt template loaded from a markdown file.
 * Extends the harness template with pi-specific provenance and a guaranteed source path.
 */
export interface PromptTemplate extends HarnessPromptTemplate {
	/** Source provenance information (user/project/temporary). */
	sourceInfo: SourceInfo;
	/** Absolute path to the template file. */
	filePath: string;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. */
	cwd: string;
	/** Agent config directory for global templates. */
	agentDir: string;
	/** Explicit prompt template paths (files or directories). */
	promptPaths: string[];
	/** Include default prompt directories (agentDir/prompts, cwd/.pi/prompts). */
	includeDefaults: boolean;
}

// CONTINUE_HERE

const isUnderPath = (target: string, root: string): boolean => {
	const normalizedRoot = resolve(root);
	if (target === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return target.startsWith(prefix);
};

/**
 * Load all prompt templates through the harness async abstraction and attach pi provenance.
 *
 * Sources:
 * 1. Global: agentDir/prompts/ (when includeDefaults)
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/ (when includeDefaults)
 * 3. Explicit prompt paths
 *
 * Each loaded template's `sourceInfo` is derived from which root it resolved under, preserving pi's
 * original `loadPromptTemplates` classification semantics.
 */
export async function loadPromptTemplates(options: LoadPromptTemplatesOptions): Promise<PromptTemplate[]> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const getSourceInfo = (filePath: string, isDir: boolean): SourceInfo => {
		if (isUnderPath(filePath, globalPromptsDir)) {
			return createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir: globalPromptsDir });
		}
		if (isUnderPath(filePath, projectPromptsDir)) {
			return createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir: projectPromptsDir });
		}
		return createSyntheticSourceInfo(filePath, {
			source: "local",
			baseDir: isDir ? filePath : filePath.slice(0, Math.max(0, filePath.lastIndexOf("/"))) || "/",
		});
	};

	// Build the sourced input list: default dirs (opt-in) followed by explicit paths, resolved to absolute.
	const inputs: Array<{ path: string; source: "global" | "project" | "explicit" }> = [];
	if (options.includeDefaults) {
		inputs.push({ path: globalPromptsDir, source: "global" });
		inputs.push({ path: projectPromptsDir, source: "project" });
	}
	for (const rawPath of options.promptPaths) {
		inputs.push({ path: resolvePath(rawPath, resolvedCwd, { trim: true }), source: "explicit" });
	}

	const env = new NodeExecutionEnv({ cwd: resolvedCwd });
	try {
		const result = await loadSourcedPromptTemplates(env, inputs, (template): PromptTemplate => {
			const filePath = template.filePath ?? "";
			return { ...template, filePath, sourceInfo: getSourceInfo(filePath, false) };
		});
		return result.promptTemplates.map((entry) => entry.promptTemplate);
	} finally {
		await env.cleanup();
	}
}

