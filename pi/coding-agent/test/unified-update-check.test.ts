import { describe, expect, it, vi } from "vitest";
import { runMagentaSelfUpdate } from "../src/utils/unified-update-check.ts";

const cleanGitStatus = {
	repoRoot: "/tmp/Magenta",
	behind: 2,
	localSha: "1111111",
	remoteSha: "2222222",
	clean: true,
	fastForwardable: true,
};

describe("runMagentaSelfUpdate", () => {
	it("uses the Magenta release updater for a compiled binary without probing a checkout", async () => {
		const checkGit = vi.fn(async () => cleanGitStatus);
		const installRelease = vi.fn(async () => ({ success: true, newVersion: "0.0.12" }));

		const result = await runMagentaSelfUpdate({
			isBunBinary: true,
			checkGit,
			installRelease,
		});

		expect(result).toEqual({ ok: true, method: "release", pending: undefined, newVersion: "0.0.12" });
		expect(installRelease).toHaveBeenCalledOnce();
		expect(checkGit).not.toHaveBeenCalled();
	});

	it("uses the Magenta checkout updater for source installs", async () => {
		const runGit = vi.fn(async () => ({ ok: true, newSha: "2222222" }));
		const result = await runMagentaSelfUpdate({
			isBunBinary: false,
			checkGit: async () => cleanGitStatus,
			runGit,
		});

		expect(result).toEqual({ ok: true, method: "git", newSha: "2222222" });
		expect(runGit).toHaveBeenCalledWith(cleanGitStatus);
	});

	it("does not rebuild an up-to-date checkout unless force is explicit", async () => {
		const status = { ...cleanGitStatus, behind: 0 };
		const runGit = vi.fn(async () => ({ ok: true, newSha: status.localSha }));

		await expect(
			runMagentaSelfUpdate({ isBunBinary: false, checkGit: async () => status, runGit }),
		).resolves.toMatchObject({ ok: true, method: "git", upToDate: true });
		expect(runGit).not.toHaveBeenCalled();

		await expect(
			runMagentaSelfUpdate({ isBunBinary: false, force: true, checkGit: async () => status, runGit }),
		).resolves.toMatchObject({ ok: true, method: "git", newSha: status.localSha });
		expect(runGit).toHaveBeenCalledOnce();
	});

	it("fails closed for a dirty checkout", async () => {
		const runGit = vi.fn(async () => ({ ok: true, newSha: "unexpected" }));
		const result = await runMagentaSelfUpdate({
			isBunBinary: false,
			checkGit: async () => ({ ...cleanGitStatus, clean: false }),
			runGit,
		});

		expect(result).toMatchObject({ ok: false, method: "git", reason: expect.stringContaining("uncommitted") });
		expect(runGit).not.toHaveBeenCalled();
	});

	it("returns only Magenta release and source guidance for unsupported installs", async () => {
		const result = await runMagentaSelfUpdate({
			isBunBinary: false,
			checkGit: async () => undefined,
			detectMethod: () => "npm",
		});

		expect(result).toMatchObject({ ok: false, method: "unsupported" });
		expect(result.reason).toContain("Minions-Land/Magenta-CLI/releases/latest");
		expect(result.reason).toContain("Minions-Land/Magenta");
		expect(result.reason).not.toContain("pi-mono");
	});
});
