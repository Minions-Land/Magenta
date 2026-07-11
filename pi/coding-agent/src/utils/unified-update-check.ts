/**
 * Unified update checking for Magenta TUI.
 * Supports both Git checkout (developer mode) and binary distribution.
 */

import { isBunBinary } from "../config.ts";
import type { UpdateCheckResult } from "./github-release-update.ts";
import { checkForUpdate as checkGitHubRelease } from "./github-release-update.ts";
import { checkForMagentaUpdate, type MagentaUpdateStatus } from "./magenta-update.ts";

export type UnifiedUpdateStatus =
	| { type: "git"; status: MagentaUpdateStatus }
	| { type: "release"; status: UpdateCheckResult }
	| { type: "unavailable" };

/**
 * Check for updates using the appropriate mechanism:
 * - Git checkout: check origin/main for new commits
 * - Binary distribution: check GitHub Releases for new versions
 */
export async function checkForAnyUpdate(): Promise<UnifiedUpdateStatus> {
	// Try Git-based update first (developer mode)
	const gitStatus = await checkForMagentaUpdate();
	if (gitStatus) {
		return { type: "git", status: gitStatus };
	}

	// Fall back to GitHub Releases (binary distribution)
	// Only check if running as a compiled binary
	if (isBunBinary) {
		try {
			const releaseStatus = await checkGitHubRelease({ force: false });
			return { type: "release", status: releaseStatus };
		} catch {
			// Silent failure - update check is best-effort
		}
	}

	return { type: "unavailable" };
}
