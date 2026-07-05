import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPackageDir } from "../config.ts";

// Magenta is installed as a git checkout of Minions-Land/Magenta (see README),
// not as an npm package. "Updating" therefore means fast-forwarding the local
// checkout to the latest origin/main and rebuilding — it only ever touches this
// GitHub repo. It is intentionally kept entirely separate from Pi's own pi.dev
// version-check / npm self-update machinery, which stays disabled.
//
// The rebuild's `npm install` does NOT pull Pi from the npm registry: the Pi
// packages (@earendil-works/pi-*) are local workspaces in this monorepo, linked
// via the root package-lock (link:true → pi/ai, pi/tui, ...). So install merely
// relinks the local Pi sources and fetches third-party deps; the running Pi is
// always the one checked out in this repo, never a published release.
const UPDATE_BRANCH = process.env.MAGENTA_UPDATE_BRANCH?.trim() || "main";
const UPDATE_REMOTE = process.env.MAGENTA_UPDATE_REMOTE?.trim() || "origin";
const GIT_TIMEOUT_MS = 20_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;

export interface MagentaUpdateStatus {
	/** Absolute path to the Magenta repo root (contains .git). */
	repoRoot: string;
	/** How many commits origin/<branch> is ahead of local HEAD. */
	behind: number;
	/** Short SHA of the local HEAD before updating. */
	localSha: string;
	/** Short SHA of the remote tip. */
	remoteSha: string;
	/** True when the working tree has no uncommitted changes. */
	clean: boolean;
	/** True when local HEAD can fast-forward to the remote tip (no divergence). */
	fastForwardable: boolean;
}

export interface MagentaUpdateResult {
	ok: boolean;
	/** New short SHA after a successful update. */
	newSha?: string;
	/** Human-readable reason when the update did not run or failed. */
	reason?: string;
}

function git(repoRoot: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): { code: number; stdout: string } {
	const options: SpawnSyncOptions = {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: timeoutMs,
		// Never let git prompt for credentials during a background check.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	};
	const result = spawnSync("git", ["--no-optional-locks", ...args], options);
	return { code: result.status ?? 1, stdout: (result.stdout as string | undefined)?.trim() ?? "" };
}

/**
 * Walk up from the running CLI's package dir to find the Magenta repo root.
 * This deliberately ignores the user's cwd: `magenta` may be launched from an
 * unrelated project, so we must update Magenta's own checkout, not that project.
 * Returns null when the CLI is not running from a git checkout (e.g. a packaged
 * install), in which case auto-update does not apply.
 */
export function findMagentaRepoRoot(): string | null {
	if (process.env.MAGENTA_REPO_ROOT?.trim()) {
		const override = process.env.MAGENTA_REPO_ROOT.trim();
		return existsSync(join(override, ".git")) ? override : null;
	}
	let dir = getPackageDir();
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		dir = dirname(dir);
	}
	return null;
}

/**
 * Fetch the update branch and report how far behind the local checkout is.
 * Returns undefined when auto-update does not apply (not a checkout, disabled,
 * offline) or when git is unavailable. Never throws.
 */
export async function checkForMagentaUpdate(): Promise<MagentaUpdateStatus | undefined> {
	if (process.env.MAGENTA_SKIP_UPDATE || process.env.PI_OFFLINE) return undefined;

	const repoRoot = findMagentaRepoRoot();
	if (!repoRoot) return undefined;

	try {
		// Refresh remote tracking refs for the update branch only.
		const fetched = git(repoRoot, ["fetch", "--quiet", UPDATE_REMOTE, UPDATE_BRANCH]);
		if (fetched.code !== 0) return undefined;

		const remoteRef = `${UPDATE_REMOTE}/${UPDATE_BRANCH}`;
		const localSha = git(repoRoot, ["rev-parse", "--short", "HEAD"]).stdout;
		const remoteSha = git(repoRoot, ["rev-parse", "--short", remoteRef]).stdout;
		if (!localSha || !remoteSha) return undefined;

		// Count commits reachable from the remote tip but not from HEAD, and the
		// reverse, to distinguish "clean fast-forward" from "diverged".
		const behind = Number.parseInt(git(repoRoot, ["rev-list", "--count", `HEAD..${remoteRef}`]).stdout || "0", 10);
		const ahead = Number.parseInt(git(repoRoot, ["rev-list", "--count", `${remoteRef}..HEAD`]).stdout || "0", 10);

		// A clean working tree has empty `git status --porcelain` output.
		const clean = git(repoRoot, ["status", "--porcelain"]).stdout.length === 0;

		return {
			repoRoot,
			behind: Number.isFinite(behind) ? behind : 0,
			localSha,
			remoteSha,
			clean,
			fastForwardable: ahead === 0,
		};
	} catch {
		return undefined;
	}
}

/**
 * Fast-forward the checkout to the remote tip and rebuild. Only safe to call
 * when the working tree is clean and fast-forwardable (see MagentaUpdateStatus);
 * callers must gate on that. Never throws — failures are returned as {ok:false}.
 */
export async function runMagentaUpdate(status: MagentaUpdateStatus): Promise<MagentaUpdateResult> {
	if (!status.clean) {
		return { ok: false, reason: "working tree has uncommitted changes" };
	}
	if (!status.fastForwardable) {
		return { ok: false, reason: "local branch has diverged from the remote" };
	}

	const { repoRoot } = status;
	try {
		const pulled = git(repoRoot, ["merge", "--ff-only", `${UPDATE_REMOTE}/${UPDATE_BRANCH}`]);
		if (pulled.code !== 0) {
			return { ok: false, reason: "git fast-forward failed" };
		}

		// Relinks local Pi workspaces and fetches third-party deps for the new
		// commit. Does not fetch Pi from the registry (see file header).
		const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: BUILD_TIMEOUT_MS,
			stdio: "ignore",
		});
		if (install.status !== 0) {
			return { ok: false, reason: "npm install failed" };
		}

		const build = spawnSync("npm", ["run", "build"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: BUILD_TIMEOUT_MS,
			stdio: "ignore",
		});
		if (build.status !== 0) {
			return { ok: false, reason: "npm run build failed" };
		}

		const newSha = git(repoRoot, ["rev-parse", "--short", "HEAD"]).stdout;
		return { ok: true, newSha: newSha || status.remoteSha };
	} catch (error: unknown) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
