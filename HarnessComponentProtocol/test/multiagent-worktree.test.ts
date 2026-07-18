import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeammateWorktreeManager } from "../tools/multiagent/magenta/worktree.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("HCP multiagent worktree generations", () => {
	let root: string;
	let manager: TeammateWorktreeManager;

	beforeEach(() => {
		root = join(tmpdir(), `hcp-multiagent-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		git(root, "init", "--quiet");
		git(root, "config", "user.email", "magenta-test@example.invalid");
		git(root, "config", "user.name", "Magenta Test");
		writeFileSync(join(root, "tracked.txt"), "before\n");
		git(root, "add", "tracked.txt");
		git(root, "commit", "--quiet", "-m", "base");
		manager = new TeammateWorktreeManager();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("captures a verified binary receipt and applies it to Main as uncommitted changes", async () => {
		const parentHead = git(root, "rev-parse", "HEAD");
		const record = await manager.provision({
			sessionId: "child-session",
			parentSessionId: "main-session",
			requestedCwd: root,
			generation: 1,
		});
		writeFileSync(join(record.checkoutPath, "tracked.txt"), "after\n");
		writeFileSync(join(record.checkoutPath, "binary.dat"), Buffer.from([0, 1, 2, 255, 4]));
		mkdirSync(join(record.checkoutPath, "empty-directory"));

		const receipt = await manager.captureReceipt(record);
		expect(receipt.changedFiles.sort()).toEqual(["binary.dat", "tracked.txt"]);
		expect(receipt.patchBytes).toBeGreaterThan(0);
		expect(receipt.patchSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(receipt.includesIgnoredFiles).toBe(false);
		expect(receipt.includesEmptyDirectories).toBe(false);
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("before\n");

		const result = await manager.integrate(record);
		expect(result).toMatchObject({ status: "applied", cleanupPending: false });
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("after\n");
		expect(readFileSync(join(root, "binary.dat"))).toEqual(Buffer.from([0, 1, 2, 255, 4]));
		expect(git(root, "rev-parse", "HEAD")).toBe(parentHead);
		expect(git(root, "status", "--porcelain")).toContain("tracked.txt");
		expect(existsSync(record.checkoutPath)).toBe(false);
		expect(JSON.parse(readFileSync(record.manifestPath, "utf8"))).toMatchObject({
			sessionId: "child-session",
			generation: 1,
			state: "integrated",
		});
	});

	it("captures and retains a discard receipt without changing Main", async () => {
		const record = await manager.provision({
			sessionId: "discard-session",
			parentSessionId: "main-session",
			requestedCwd: root,
		});
		writeFileSync(join(record.checkoutPath, "tracked.txt"), "discarded\n");
		await manager.discard(record, true);

		expect(record.state).toBe("discarded");
		expect(record.receipt?.changedFiles).toContain("tracked.txt");
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("before\n");
		expect(existsSync(record.checkoutPath)).toBe(false);
	});

	it("rejects provisioning from a dirty Main checkout", async () => {
		writeFileSync(join(root, "dirty.txt"), "uncommitted\n");
		await expect(
			manager.provision({
				sessionId: "dirty-session",
				parentSessionId: "main-session",
				requestedCwd: root,
			}),
		).rejects.toThrow("dirty parent checkout");
	});

	it("detects a manifest whose Session identity was tampered", async () => {
		const record = await manager.provision({
			sessionId: "validated-session",
			parentSessionId: "main-session",
			requestedCwd: root,
		});
		const manifest = JSON.parse(readFileSync(record.manifestPath, "utf8"));
		manifest.sessionId = "other-session";
		writeFileSync(record.manifestPath, `${JSON.stringify(manifest)}\n`);
		await expect(manager.validate(record)).rejects.toThrow("manifest sessionId mismatch");
	});
});
