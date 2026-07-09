import type { HcpServer } from "../../hcp-client/contract/hcp-server.ts";
import type { ContextFile } from "./magenta/context.ts";

/**
 * The context capability surface consumed by the agent loop. This is the
 * injection contract: the loop calls the source-selected provider instead of
 * statically importing context discovery, so the assembly layer decides which
 * source (magenta, ...) supplies the behavior.
 */
export interface ContextProvider {
	/**
	 * Discover and read context files (CLAUDE.md, AGENTS.md, etc.) from the
	 * workspace, expanding imports and sanitizing for model consumption.
	 */
	discoverContextFiles(workspaceRoot: string): Promise<ContextFile[]>;

	/**
	 * Convert this provider into an HCP target for registration in the HCP
	 * registry. The target handles context:// URIs and exposes discover/read/status
	 * operations.
	 */
	toHcpServer(): HcpServer;
}

// Re-export supporting types for convenience
export type { ContextFile } from "./magenta/context.ts";
