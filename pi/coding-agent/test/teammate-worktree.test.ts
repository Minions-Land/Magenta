import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeammateWorktreeManager } from "../src/core/tools/teammate-worktree.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
	}).trim();
}

describe("TeammateWorktreeManager", () => {
	let root: string;
	let manager: TeammateWorktreeManager;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "magenta-teammate-worktree-"));
		git(root, "init", "--quiet");
		git(root, "config", "user.email", "tests@example.com");
		git(root, "config", "user.name", "Magenta Tests");
		writeFileSync(join(root, "tracked.txt"), "base\n");
		await mkdir(join(root, "packages", "nested"), { recursive: true });
		writeFileSync(join(root, "packages", "nested", "remove-me.txt"), "remove\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		manager = new TeammateWorktreeManager();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a parent-session-scoped linked worktree and maps nested cwd", async () => {
		const record = await manager.provision({
			teammateId: "teammate_001",
			parentSessionId: "parent/session",
			requestedCwd: join(root, "packages", "nested"),
		});

		expect(record.checkoutPath).toContain(join(".magenta", "tmp", "collaboration", "parent-session"));
		expect(record.checkoutCwd).toBe(join(record.checkoutPath, "packages", "nested"));
		expect(git(record.checkoutPath, "rev-parse", "HEAD")).toBe(record.baseCommit);
		expect(git(root, "status", "--porcelain")).toBe("");
		expect(existsSync(record.manifestPath)).toBe(true);

		await manager.discard(record, true);
	});

	it("captures committed, unstaged, untracked, deleted, and binary changes in one receipt", async () => {
		const record = await manager.provision({
			teammateId: "teammate_002",
			parentSessionId: "parent-2",
			requestedCwd: root,
		});
		writeFileSync(join(record.checkoutPath, "committed.txt"), "committed\n");
		git(record.checkoutPath, "add", "committed.txt");
		git(
			record.checkoutPath,
			"-c",
			"user.email=tests@example.com",
			"-c",
			"user.name=Tests",
			"commit",
			"--quiet",
			"-m",
			"child commit",
		);
		writeFileSync(join(record.checkoutPath, "tracked.txt"), "changed\n");
		writeFileSync(join(record.checkoutPath, "untracked.txt"), "new\n");
		writeFileSync(join(record.checkoutPath, "binary.bin"), Buffer.from([0, 1, 2, 255]));
		rmSync(join(record.checkoutPath, "packages"), { recursive: true, force: true });

		const receipt = await manager.captureReceipt(record);
		expect(receipt.changedFiles).toEqual(
			expect.arrayContaining([
				"binary.bin",
				"committed.txt",
				"packages/nested/remove-me.txt",
				"tracked.txt",
				"untracked.txt",
			]),
		);
		expect(receipt.patchBytes).toBeGreaterThan(0);
		expect(receipt.patchSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(readFileSync(receipt.patchPath, "utf8")).toContain("diff --git");
		expect(record.state).toBe("terminal_unintegrated");

		await manager.discard(record, true);
	});

	it("integrates a complete receipt into a clean parent and removes the worktree", async () => {
		const record = await manager.provision({
			teammateId: "teammate_003",
			parentSessionId: "parent-3",
			requestedCwd: root,
		});
		writeFileSync(join(record.checkoutPath, "tracked.txt"), "integrated\n");
		writeFileSync(join(record.checkoutPath, "new.txt"), "new file\n");

		const result = await manager.integrate(record);
		expect(result.status).toBe("applied");
		expect(result.changedFiles).toEqual(expect.arrayContaining(["new.txt", "tracked.txt"]));
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("integrated\n");
		expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("new file\n");
		expect(existsSync(record.checkoutPath)).toBe(false);
		expect(git(root, "status", "--porcelain")).toContain("new.txt");
	});

	it("rejects dirty parent creation and dirty-parent integration without modifying it", async () => {
		writeFileSync(join(root, "tracked.txt"), "dirty before start\n");
		await expect(
			manager.provision({ teammateId: "teammate_dirty", parentSessionId: "parent", requestedCwd: root }),
		).rejects.toThrow("dirty parent checkout");
		git(root, "checkout", "--", "tracked.txt");

		const record = await manager.provision({
			teammateId: "teammate_004",
			parentSessionId: "parent-4",
			requestedCwd: root,
		});
		writeFileSync(join(record.checkoutPath, "worker.txt"), "worker\n");
		await manager.captureReceipt(record);
		writeFileSync(join(root, "tracked.txt"), "parent dirty\n");
		await expect(manager.integrate(record)).rejects.toThrow("dirty parent checkout");
		expect(existsSync(join(root, "worker.txt"))).toBe(false);
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("parent dirty\n");

		git(root, "checkout", "--", "tracked.txt");
		await manager.discard(record, true);
	});

	it("detects a tampered receipt and requires explicit discard confirmation", async () => {
		const record = await manager.provision({
			teammateId: "teammate_005",
			parentSessionId: "parent-5",
			requestedCwd: root,
		});
		writeFileSync(join(record.checkoutPath, "worker.txt"), "worker\n");
		const receipt = await manager.captureReceipt(record);
		await expect(manager.discard(record, false)).rejects.toThrow("confirm=true");
		writeFileSync(receipt.patchPath, "tampered\n");
		await expect(manager.integrate(record)).rejects.toThrow("hash mismatch");
		expect(existsSync(record.checkoutPath)).toBe(true);
	});
});
