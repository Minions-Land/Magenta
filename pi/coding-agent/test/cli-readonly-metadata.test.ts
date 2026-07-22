import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releaseUpdateMocks = vi.hoisted(() => ({
	ensureCurrentReleaseResources: vi.fn(async () => false),
}));

vi.mock("../src/utils/github-release-update.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/github-release-update.ts")>()),
	ensureCurrentReleaseResources: releaseUpdateMocks.ensureCurrentReleaseResources,
}));

import { ENV_AGENT_DIR, VERSION } from "../src/config.ts";
import { main } from "../src/main.ts";

describe("read-only CLI metadata probes", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "magenta-cli-metadata-"));
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
		releaseUpdateMocks.ensureCurrentReleaseResources.mockClear();
		vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prints --version before resource initialization or agent-directory writes", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await main(["--version"]);

		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(VERSION);
		expect(releaseUpdateMocks.ensureCurrentReleaseResources).not.toHaveBeenCalled();
		expect(existsSync(process.env[ENV_AGENT_DIR] as string)).toBe(false);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("prints static help before resource initialization for a pure help command", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await main(["--help"]);

		expect(log).toHaveBeenCalledOnce();
		expect(String(log.mock.calls[0]?.[0])).toContain("Usage:");
		expect(releaseUpdateMocks.ensureCurrentReleaseResources).not.toHaveBeenCalled();
		expect(existsSync(process.env[ENV_AGENT_DIR] as string)).toBe(false);
		expect(process.exit).toHaveBeenCalledWith(0);
	});
});
