/**
 * Unified update checking for Magenta TUI.
 * Supports both Git checkout (developer mode) and binary distribution.
 */

import { detectInstallMethod, isBunBinary } from "../config.ts";
import type { UpdateCheckResult, UpdateInstallResult } from "./github-release-update.ts";
import { checkForUpdate as checkGitHubRelease, installUpdate } from "./github-release-update.ts";
import { checkForMagentaUpdate, type MagentaUpdateStatus, runMagentaUpdate } from "./magenta-update.ts";

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

export interface MagentaSelfUpdateResult {
	ok: boolean;
	method: "git" | "release" | "unsupported";
	upToDate?: boolean;
	pending?: boolean;
	newVersion?: string;
	newSha?: string;
	reason?: string;
}

export interface MagentaSelfUpdateOptions {
	force?: boolean;
	isBunBinary?: boolean;
	checkGit?: typeof checkForMagentaUpdate;
	runGit?: typeof runMagentaUpdate;
	installRelease?: typeof installUpdate;
	detectMethod?: typeof detectInstallMethod;
}

/** Execute the one and only Magenta self-update flow for every install channel. */
export async function runMagentaSelfUpdate(options: MagentaSelfUpdateOptions = {}): Promise<MagentaSelfUpdateResult> {
	const checkGit = options.checkGit ?? checkForMagentaUpdate;
	const runGit = options.runGit ?? runMagentaUpdate;
	const installRelease = options.installRelease ?? installUpdate;
	const binaryInstall = options.isBunBinary ?? isBunBinary;
	if (binaryInstall) {
		const result: UpdateInstallResult = await installRelease();
		if (result.success) {
			return {
				ok: true,
				method: "release",
				pending: result.pending,
				newVersion: result.newVersion,
			};
		}
		if (result.error?.startsWith("Already on latest version")) {
			return { ok: true, method: "release", upToDate: true };
		}
		return { ok: false, method: "release", reason: result.error ?? "Magenta release update failed" };
	}

	const gitStatus = await checkGit();
	if (gitStatus) {
		if (gitStatus.behind === 0 && !options.force) {
			return { ok: true, method: "git", upToDate: true, newSha: gitStatus.localSha };
		}
		if (!gitStatus.clean) {
			return { ok: false, method: "git", reason: "Magenta checkout has uncommitted changes" };
		}
		if (!gitStatus.fastForwardable) {
			return { ok: false, method: "git", reason: "Magenta checkout has diverged from origin/main" };
		}
		const result = await runGit(gitStatus);
		return result.ok
			? { ok: true, method: "git", newSha: result.newSha }
			: { ok: false, method: "git", reason: result.reason ?? "Magenta git update failed" };
	}

	const method = (options.detectMethod ?? detectInstallMethod)();
	return {
		ok: false,
		method: "unsupported",
		reason: `Self-update is unavailable for the detected ${method} installation. Download a Magenta release from https://github.com/Minions-Land/Magenta-CLI/releases/latest or update the Magenta source checkout from https://github.com/Minions-Land/Magenta.`,
	};
}
