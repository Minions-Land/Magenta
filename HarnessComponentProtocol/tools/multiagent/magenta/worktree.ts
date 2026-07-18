import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const INTEGRATION_LOCK = "magenta-teammate-integration.lock";

export type TeammateWorkspaceState =
	| "active"
	| "terminal_unintegrated"
	| "receipt_error"
	| "integrated"
	| "discarded"
	| "cleanup_pending";

export type TeammateChangeReceipt = {
	createdAt: number;
	baseCommit: string;
	headCommit: string;
	snapshotTree: string;
	patchPath: string;
	patchSha256: string;
	patchBytes: number;
	changedFiles: string[];
	insertions: number;
	deletions: number;
	includesIgnoredFiles: false;
	includesEmptyDirectories: false;
};

export type TeammateWorktreeRecord = {
	version: 1;
	generation: number;
	sessionId: string;
	parentSessionId: string;
	repoRoot: string;
	gitCommonDir: string;
	collaborationRoot: string;
	checkoutPath: string;
	checkoutCwd: string;
	requestedRelativeCwd: string;
	branch: string;
	baseCommit: string;
	manifestPath: string;
	state: TeammateWorkspaceState;
	createdAt: number;
	updatedAt: number;
	receipt?: TeammateChangeReceipt;
	integratedAt?: number;
	discardedAt?: number;
	parentHeadBeforeIntegration?: string;
	cleanupError?: string;
	lastError?: string;
};

export type TeammateIntegrationResult = {
	status: "applied" | "no_changes" | "already_integrated";
	changedFiles: string[];
	patchSha256?: string;
	parentHeadBefore?: string;
	cleanupPending: boolean;
};

type GitResult = { stdout: Buffer; stderr: string; exitCode: number };

function safeSegment(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized || "session";
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function decode(buffer: Buffer): string {
	return buffer.toString("utf8").trim();
}

async function runGit(
	cwd: string,
	args: string[],
	options?: { env?: NodeJS.ProcessEnv; maxBytes?: number; allowExitCodes?: number[] },
): Promise<GitResult> {
	const maxBytes = options?.maxBytes ?? MAX_GIT_OUTPUT_BYTES;
	const child = spawn("git", ["-C", cwd, ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
			...options?.env,
		},
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	let killedForLimit = false;
	const collect = (target: Buffer[], chunk: Buffer): void => {
		bytes += chunk.byteLength;
		if (bytes > maxBytes) {
			killedForLimit = true;
			child.kill("SIGKILL");
			return;
		}
		target.push(Buffer.from(chunk));
	};
	child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
	child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`git ${args[0] ?? "command"} timed out after ${GIT_TIMEOUT_MS}ms`));
		}, GIT_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolveExit({ code, signal });
		});
	});
	if (killedForLimit) throw new Error(`git ${args[0] ?? "command"} exceeded ${maxBytes} bytes of output`);
	const allowed = options?.allowExitCodes ?? [0];
	if (exit.code === null || !allowed.includes(exit.code)) {
		const errorText = Buffer.concat(stderr).toString("utf8").trim();
		throw new Error(
			`git ${args.join(" ")} failed (code=${exit.code ?? "null"} signal=${exit.signal ?? "none"})${errorText ? `: ${errorText}` : ""}`,
		);
	}
	return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: exit.code };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function ensureMagentaExcluded(gitCommonDir: string): Promise<void> {
	const infoDir = join(gitCommonDir, "info");
	const excludePath = join(infoDir, "exclude");
	await mkdir(infoDir, { recursive: true, mode: 0o700 });
	let current = "";
	try {
		current = await readFile(excludePath, "utf8");
	} catch {
		// The local exclude file is optional.
	}
	if (current.split(/\r?\n/).some((line) => line.trim() === "/.magenta/")) return;
	await appendFile(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}/.magenta/\n`, { mode: 0o600 });
}

async function assertDirectory(path: string, label: string): Promise<void> {
	const info = await stat(path).catch(() => undefined);
	if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function parseNumstat(output: string): { insertions: number; deletions: number } {
	let insertions = 0;
	let deletions = 0;
	for (const line of output.split("\n")) {
		const [added, removed] = line.split("\t");
		if (added && added !== "-") insertions += Number.parseInt(added, 10) || 0;
		if (removed && removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
	}
	return { insertions, deletions };
}

export class TeammateWorktreeManager {
	async provision(input: {
		sessionId: string;
		parentSessionId: string;
		requestedCwd: string;
		generation?: number;
	}): Promise<TeammateWorktreeRecord> {
		const requestedCwd = await realpath(input.requestedCwd);
		await assertDirectory(requestedCwd, "Teammate working directory");
		const repoRoot = decode((await runGit(requestedCwd, ["rev-parse", "--show-toplevel"])).stdout);
		const superproject = decode(
			(await runGit(requestedCwd, ["rev-parse", "--show-superproject-working-tree"])).stdout,
		);
		if (superproject) throw new Error("Managed teammate worktrees do not support starting inside a Git submodule");
		const baseCommit = decode((await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"])).stdout);
		const gitCommonValue = decode((await runGit(repoRoot, ["rev-parse", "--git-common-dir"])).stdout);
		const gitCommonDir = isAbsolute(gitCommonValue) ? gitCommonValue : resolve(repoRoot, gitCommonValue);
		const dirty = (await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
		if (dirty.byteLength > 0) {
			throw new Error(
				"Cannot create a managed teammate worktree from a dirty parent checkout. Commit/stash the parent changes or use workspace=shared for intentional read-only collaboration.",
			);
		}
		await ensureMagentaExcluded(gitCommonDir);

		const requestedRelativeCwd = relative(repoRoot, requestedCwd);
		if (!isWithin(repoRoot, requestedCwd)) throw new Error("Requested teammate cwd is outside its Git repository");
		const parentSegment = safeSegment(input.parentSessionId);
		const teammateSegment = safeSegment(input.sessionId);
		const generation = Math.max(1, Math.floor(input.generation ?? 1));
		const generationSegment = `generation-${String(generation).padStart(3, "0")}`;
		const collaborationRoot = join(repoRoot, ".magenta", "tmp", "collaboration", parentSegment);
		const checkoutPath = join(collaborationRoot, "worktrees", teammateSegment, generationSegment);
		const recordDir = join(collaborationRoot, "receipts", teammateSegment, generationSegment);
		const manifestPath = join(recordDir, "manifest.json");
		if (existsSync(checkoutPath) || existsSync(manifestPath)) {
			throw new Error(`Managed teammate workspace already exists for ${input.sessionId}`);
		}
		await mkdir(dirname(checkoutPath), { recursive: true, mode: 0o700 });
		await mkdir(recordDir, { recursive: true, mode: 0o700 });
		const branch = `magenta/teammate/${safeSegment(input.parentSessionId).slice(0, 12)}/${teammateSegment}-g${generation}-${randomUUID().slice(0, 8)}`;
		const checkoutCwd = join(checkoutPath, requestedRelativeCwd);
		const now = Date.now();
		const record: TeammateWorktreeRecord = {
			version: 1,
			generation,
			sessionId: input.sessionId,
			parentSessionId: input.parentSessionId,
			repoRoot,
			gitCommonDir,
			collaborationRoot,
			checkoutPath,
			checkoutCwd,
			requestedRelativeCwd,
			branch,
			baseCommit,
			manifestPath,
			state: "active",
			createdAt: now,
			updatedAt: now,
		};
		await writeJsonAtomic(manifestPath, { ...record, state: "provisioning" });
		try {
			await runGit(repoRoot, ["worktree", "add", "--quiet", "-b", branch, checkoutPath, baseCommit]);
			await assertDirectory(checkoutCwd, "Mapped teammate worktree cwd");
			const actualHead = decode((await runGit(checkoutPath, ["rev-parse", "HEAD"])).stdout);
			if (actualHead !== baseCommit) throw new Error(`Worktree opened ${actualHead}; expected ${baseCommit}`);
			await this.assertRegistered(record);
			await writeJsonAtomic(manifestPath, record);
			return record;
		} catch (error) {
			record.state = "receipt_error";
			record.lastError = error instanceof Error ? error.message : String(error);
			record.updatedAt = Date.now();
			await writeJsonAtomic(manifestPath, record).catch(() => undefined);
			throw error;
		}
	}

	async validate(record: TeammateWorktreeRecord): Promise<TeammateWorktreeRecord> {
		const parsed = JSON.parse(await readFile(record.manifestPath, "utf8")) as TeammateWorktreeRecord;
		for (const [field, expected] of [
			["version", 1],
			["generation", record.generation],
			["sessionId", record.sessionId],
			["parentSessionId", record.parentSessionId],
			["repoRoot", record.repoRoot],
			["gitCommonDir", record.gitCommonDir],
			["collaborationRoot", record.collaborationRoot],
			["checkoutPath", record.checkoutPath],
			["manifestPath", record.manifestPath],
			["branch", record.branch],
			["baseCommit", record.baseCommit],
		] as const) {
			if (parsed[field] !== expected) throw new Error(`Managed teammate manifest ${field} mismatch`);
		}
		if (!isWithin(parsed.collaborationRoot, parsed.checkoutPath)) {
			throw new Error("Managed teammate checkout escaped its collaboration root");
		}
		if (!["integrated", "discarded", "cleanup_pending"].includes(parsed.state)) {
			await this.assertRegistered(parsed);
		}
		return parsed;
	}

	async captureReceipt(record: TeammateWorktreeRecord): Promise<TeammateChangeReceipt> {
		if (record.receipt) return record.receipt;
		if (record.state === "integrated" || record.state === "discarded") {
			throw new Error(`Cannot capture changes for ${record.sessionId}: workspace is ${record.state}`);
		}
		await this.assertRegistered(record);
		const dirtySubmodules = decode(
			(
				await runGit(record.checkoutPath, [
					"submodule",
					"foreach",
					"--quiet",
					"--recursive",
					"git status --porcelain --untracked-files=all",
				])
			).stdout,
		);
		if (dirtySubmodules) {
			throw new Error("Cannot capture teammate receipt while a submodule contains uncommitted changes");
		}
		const recordDir = resolve(record.manifestPath, "..");
		const indexPath = join(recordDir, `receipt-index-${randomUUID()}`);
		const patchPath = join(recordDir, `changes-${Date.now()}.patch`);
		const env = { GIT_INDEX_FILE: indexPath };
		try {
			await runGit(record.checkoutPath, ["read-tree", record.baseCommit], { env });
			await runGit(record.checkoutPath, ["add", "-A", "--", "."], { env });
			const snapshotTree = decode((await runGit(record.checkoutPath, ["write-tree"], { env })).stdout);
			const patch = (
				await runGit(
					record.checkoutPath,
					["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", record.baseCommit, "--"],
					{ env },
				)
			).stdout;
			await writeFile(patchPath, patch, { mode: 0o600 });
			await chmod(patchPath, 0o600);
			const names = (
				await runGit(record.checkoutPath, ["diff", "--cached", "--name-only", "-z", record.baseCommit, "--"], {
					env,
				})
			).stdout
				.toString("utf8")
				.split("\0")
				.filter(Boolean);
			const numstat = decode(
				(
					await runGit(record.checkoutPath, ["diff", "--cached", "--numstat", record.baseCommit, "--"], {
						env,
					})
				).stdout,
			);
			const headCommit = decode((await runGit(record.checkoutPath, ["rev-parse", "HEAD"])).stdout);
			const receipt: TeammateChangeReceipt = {
				createdAt: Date.now(),
				baseCommit: record.baseCommit,
				headCommit,
				snapshotTree,
				patchPath,
				patchSha256: createHash("sha256").update(patch).digest("hex"),
				patchBytes: patch.byteLength,
				changedFiles: names,
				...parseNumstat(numstat),
				includesIgnoredFiles: false,
				includesEmptyDirectories: false,
			};
			record.receipt = receipt;
			record.state = "terminal_unintegrated";
			record.updatedAt = Date.now();
			record.lastError = undefined;
			await writeJsonAtomic(record.manifestPath, record);
			return receipt;
		} catch (error) {
			record.state = "receipt_error";
			record.lastError = error instanceof Error ? error.message : String(error);
			record.updatedAt = Date.now();
			await writeJsonAtomic(record.manifestPath, record).catch(() => undefined);
			throw error;
		} finally {
			await rm(indexPath, { force: true }).catch(() => undefined);
		}
	}

	async reactivate(record: TeammateWorktreeRecord): Promise<void> {
		if (record.state === "integrated" || record.state === "discarded" || record.state === "cleanup_pending") {
			throw new Error(`Cannot resume teammate ${record.sessionId}: workspace is ${record.state}`);
		}
		await this.assertRegistered(record);
		record.state = "active";
		record.receipt = undefined;
		record.lastError = undefined;
		record.updatedAt = Date.now();
		await writeJsonAtomic(record.manifestPath, record);
	}

	async integrate(record: TeammateWorktreeRecord): Promise<TeammateIntegrationResult> {
		if (record.state === "integrated" || record.state === "cleanup_pending") {
			if (record.state === "cleanup_pending") {
				try {
					await this.cleanupWorktree(record);
					record.state = "integrated";
					record.cleanupError = undefined;
					record.updatedAt = Date.now();
					await writeJsonAtomic(record.manifestPath, record);
				} catch {
					// The patch is already applied. Preserve cleanup_pending for another retry.
				}
			}
			return {
				status: "already_integrated",
				changedFiles: record.receipt?.changedFiles ?? [],
				patchSha256: record.receipt?.patchSha256,
				parentHeadBefore: record.parentHeadBeforeIntegration,
				cleanupPending: record.state === "cleanup_pending",
			};
		}
		if (record.state === "discarded") throw new Error(`Cannot integrate discarded teammate ${record.sessionId}`);
		const receipt = await this.captureReceipt(record);
		const release = await lockfile.lock(record.gitCommonDir, {
			realpath: false,
			lockfilePath: join(record.gitCommonDir, INTEGRATION_LOCK),
			retries: { retries: 40, factor: 1, minTimeout: 100, maxTimeout: 100 },
			stale: 120_000,
		});
		try {
			await this.assertRegistered(record);
			const actualPatch = await readFile(receipt.patchPath);
			const actualHash = createHash("sha256").update(actualPatch).digest("hex");
			if (actualHash !== receipt.patchSha256) throw new Error("Teammate patch receipt hash mismatch");
			await this.assertParentReady(record);
			const parentHeadBefore = decode((await runGit(record.repoRoot, ["rev-parse", "HEAD"])).stdout);
			if (receipt.patchBytes > 0) {
				await runGit(record.repoRoot, ["apply", "--check", "--binary", receipt.patchPath]);
				await this.assertParentReady(record);
				const secondHead = decode((await runGit(record.repoRoot, ["rev-parse", "HEAD"])).stdout);
				if (secondHead !== parentHeadBefore) throw new Error("Parent HEAD changed during teammate integration");
				await runGit(record.repoRoot, ["apply", "--binary", receipt.patchPath]);
			}
			record.state = "integrated";
			record.integratedAt = Date.now();
			record.parentHeadBeforeIntegration = parentHeadBefore;
			record.updatedAt = Date.now();
			await writeJsonAtomic(record.manifestPath, record);
			let cleanupPending = false;
			try {
				await this.cleanupWorktree(record);
			} catch (error) {
				cleanupPending = true;
				record.state = "cleanup_pending";
				record.cleanupError = error instanceof Error ? error.message : String(error);
				record.updatedAt = Date.now();
				await writeJsonAtomic(record.manifestPath, record);
			}
			return {
				status: receipt.patchBytes > 0 ? "applied" : "no_changes",
				changedFiles: receipt.changedFiles,
				patchSha256: receipt.patchSha256,
				parentHeadBefore,
				cleanupPending,
			};
		} finally {
			await release();
		}
	}

	async discard(record: TeammateWorktreeRecord, confirm: boolean): Promise<void> {
		if (!confirm) throw new Error("Discarding teammate changes requires confirm=true");
		if (record.state === "integrated" || record.state === "cleanup_pending") {
			throw new Error(`Cannot discard teammate ${record.sessionId}: changes were already integrated`);
		}
		if (record.state === "discarded") return;
		await this.captureReceipt(record);
		const release = await lockfile.lock(record.gitCommonDir, {
			realpath: false,
			lockfilePath: join(record.gitCommonDir, INTEGRATION_LOCK),
			retries: { retries: 40, factor: 1, minTimeout: 100, maxTimeout: 100 },
			stale: 120_000,
		});
		try {
			await this.cleanupWorktree(record);
			record.state = "discarded";
			record.discardedAt = Date.now();
			record.updatedAt = Date.now();
			await writeJsonAtomic(record.manifestPath, record);
		} finally {
			await release();
		}
	}

	private async assertParentReady(record: TeammateWorktreeRecord): Promise<void> {
		const dirty = (await runGit(record.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
		if (dirty.byteLength > 0) throw new Error("Cannot integrate teammate changes into a dirty parent checkout");
		for (const marker of [
			"MERGE_HEAD",
			"CHERRY_PICK_HEAD",
			"REVERT_HEAD",
			"BISECT_LOG",
			"rebase-merge",
			"rebase-apply",
		]) {
			if (existsSync(join(record.gitCommonDir, marker))) {
				throw new Error(`Cannot integrate while Git operation marker ${marker} exists`);
			}
		}
	}

	private async assertRegistered(record: TeammateWorktreeRecord): Promise<void> {
		if (!isWithin(record.collaborationRoot, record.checkoutPath)) {
			throw new Error("Managed teammate checkout escaped its collaboration root");
		}
		const listed = decode((await runGit(record.repoRoot, ["worktree", "list", "--porcelain"])).stdout);
		const paths = listed
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => resolve(line.slice("worktree ".length)));
		if (!paths.includes(resolve(record.checkoutPath))) {
			throw new Error(`Managed teammate worktree is no longer registered: ${record.checkoutPath}`);
		}
	}

	private async cleanupWorktree(record: TeammateWorktreeRecord): Promise<void> {
		if (!isWithin(record.collaborationRoot, record.checkoutPath)) {
			throw new Error("Managed teammate checkout escaped its collaboration root");
		}
		const listed = decode((await runGit(record.repoRoot, ["worktree", "list", "--porcelain"])).stdout);
		const registered = listed
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => resolve(line.slice("worktree ".length)))
			.includes(resolve(record.checkoutPath));
		if (registered) await runGit(record.repoRoot, ["worktree", "remove", "--force", record.checkoutPath]);
		const branch = await runGit(record.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`], {
			allowExitCodes: [0, 1],
		});
		if (branch.exitCode === 0) await runGit(record.repoRoot, ["branch", "-D", record.branch]);
	}
}
