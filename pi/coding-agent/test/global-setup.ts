import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_DIR_ENV = "MAGENTA_CODING_AGENT_DIR";

export default function setup(): () => void {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousTmpDir = process.env.TMPDIR;
	const testHome = mkdtempSync(join(tmpdir(), "magenta-coding-agent-vitest-"));
	// Unix-domain wake sockets have a small path limit, so keep TMPDIR both
	// isolated and deliberately short.
	const testTmpDir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "mgv-"));
	mkdirSync(testTmpDir, { recursive: true });

	process.env.HOME = testHome;
	process.env[AGENT_DIR_ENV] = join(testHome, ".magenta", "agent");
	process.env.TMPDIR = testTmpDir;

	return () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		rmSync(testTmpDir, { recursive: true, force: true });
		rmSync(testHome, { recursive: true, force: true });
	};
}
