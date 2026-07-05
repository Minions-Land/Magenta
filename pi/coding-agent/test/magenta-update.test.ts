import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkForMagentaUpdate, findMagentaRepoRoot, runMagentaUpdate } from "../src/utils/magenta-update.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(["init", "--initial-branch=main"], dir);
	git(["config", "--local", "user.email", "test@test.com"], dir);
	git(["config", "--local", "user.name", "Test"], dir);
	git(["config", "--local", "commit.gpgsign", "false"], dir);
}

function commit(dir: string, file: string, content: string, message: string): void {
	writeFileSync(join(dir, file), content);
	git(["add", file], dir);
	git(["commit", "--no-gpg-sign", "-m", message], dir);
}

const savedEnv = {
	repoRoot: process.env.MAGENTA_REPO_ROOT,
	skip: process.env.MAGENTA_SKIP_UPDATE,
	offline: process.env.PI_OFFLINE,
};

let workspace: string;
let remote: string;
let local: string;

beforeEach(() => {
	workspace = join(tmpdir(), `magenta-update-test-${process.pid}-${Math.floor(performance.now())}`);
	remote = join(workspace, "remote");
	local = join(workspace, "local");

	// Build a bare-ish "remote" with one commit, then clone it as the local checkout.
	initRepo(remote);
	commit(remote, "VERSION", "1", "initial");
	spawnSync("git", ["clone", "--quiet", remote, local], { encoding: "utf-8" });
	git(["config", "--local", "user.email", "test@test.com"], local);
	git(["config", "--local", "user.name", "Test"], local);
	git(["config", "--local", "commit.gpgsign", "false"], local);

	process.env.MAGENTA_REPO_ROOT = local;
	delete process.env.MAGENTA_SKIP_UPDATE;
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	for (const [key, value] of [
		["MAGENTA_REPO_ROOT", savedEnv.repoRoot],
		["MAGENTA_SKIP_UPDATE", savedEnv.skip],
		["PI_OFFLINE", savedEnv.offline],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

describe("findMagentaRepoRoot", () => {
	it("honors the MAGENTA_REPO_ROOT override when it is a git checkout", () => {
		expect(findMagentaRepoRoot()).toBe(local);
	});

	it("returns null when the override is not a git checkout", () => {
		process.env.MAGENTA_REPO_ROOT = remote.replace("remote", "nonexistent");
		expect(findMagentaRepoRoot()).toBeNull();
	});
});

describe("checkForMagentaUpdate", () => {
	it("reports behind=0 when the checkout is up to date", async () => {
		const status = await checkForMagentaUpdate();
		expect(status?.behind).toBe(0);
		expect(status?.clean).toBe(true);
		expect(status?.fastForwardable).toBe(true);
	});

	it("detects commits added to the remote", async () => {
		commit(remote, "VERSION", "2", "second");
		const status = await checkForMagentaUpdate();
		expect(status?.behind).toBe(1);
		expect(status?.fastForwardable).toBe(true);
		expect(status?.clean).toBe(true);
	});

	it("flags a dirty working tree", async () => {
		commit(remote, "VERSION", "2", "second");
		writeFileSync(join(local, "VERSION"), "dirty");
		const status = await checkForMagentaUpdate();
		expect(status?.behind).toBe(1);
		expect(status?.clean).toBe(false);
	});

	it("flags a diverged local branch as not fast-forwardable", async () => {
		commit(remote, "VERSION", "2", "remote-change");
		commit(local, "LOCAL", "x", "local-only");
		const status = await checkForMagentaUpdate();
		expect(status?.behind).toBe(1);
		expect(status?.fastForwardable).toBe(false);
	});

	it("skips when MAGENTA_SKIP_UPDATE is set", async () => {
		process.env.MAGENTA_SKIP_UPDATE = "1";
		expect(await checkForMagentaUpdate()).toBeUndefined();
	});

	it("skips when PI_OFFLINE is set", async () => {
		process.env.PI_OFFLINE = "1";
		expect(await checkForMagentaUpdate()).toBeUndefined();
	});
});

describe("runMagentaUpdate guards", () => {
	it("refuses to update a dirty working tree", async () => {
		const result = await runMagentaUpdate({
			repoRoot: local,
			behind: 1,
			localSha: "aaa",
			remoteSha: "bbb",
			clean: false,
			fastForwardable: true,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/uncommitted/);
	});

	it("refuses to update a diverged branch", async () => {
		const result = await runMagentaUpdate({
			repoRoot: local,
			behind: 1,
			localSha: "aaa",
			remoteSha: "bbb",
			clean: true,
			fastForwardable: false,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/diverged/);
	});
});
