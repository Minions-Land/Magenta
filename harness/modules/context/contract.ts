import type { ContextFile } from "./magenta/context.ts";

/**
 * The context capability surface consumed by the agent loop. This is the
 * injection contract: the loop calls the source-selected provider instead of
 * statically importing context discovery, so the assembly layer decides which
 * source (magenta, ...) supplies the behavior.
 *
 * Note: This interface contains only business logic. Conversion to HcpServer
 * is handled by the unified capability-server adapter, not by the provider.
 */
export interface ContextProvider {
	/**
	 * Discover and read context files (CLAUDE.md, AGENTS.md, etc.) from the
	 * workspace, expanding imports and sanitizing for model consumption.
	 */
	discoverContextFiles(workspaceRoot: string): Promise<ContextFile[]>;
}

// Re-export supporting types for convenience
export type { ContextFile } from "./magenta/context.ts";
