/** Compatibility facade for the HCP-owned system-prompt Capability. */

import {
	type BuildSystemPromptOptions,
	type SystemPromptDocumentationPaths,
	SystemPromptProvider,
} from "@magenta/harness";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";

export type { BuildSystemPromptOptions } from "@magenta/harness";

/** Host-owned resolution of Magenta's installed documentation locations. */
export function getSystemPromptDocumentationPaths(): SystemPromptDocumentationPaths {
	return {
		readmePath: getReadmePath(),
		docsPath: getDocsPath(),
		examplesPath: getExamplesPath(),
	};
}

/**
 * Legacy entry point for loaders and SDK callers that do not expose a session
 * HCP. AgentSession resolves the selected capability instead when an HCP exists.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	return new SystemPromptProvider().buildSystemPrompt({
		...options,
		documentationPaths: options.documentationPaths ?? getSystemPromptDocumentationPaths(),
	});
}
