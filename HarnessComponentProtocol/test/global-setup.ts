import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_DIR_ENV = "MAGENTA_CODING_AGENT_DIR";
const WORKFLOW_STATE_ROOT_ENV = "MAGENTA_WORKFLOW_STATE_ROOT";

export default function setup(): () => void {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousWorkflowRoot = process.env[WORKFLOW_STATE_ROOT_ENV];
	const testHome = mkdtempSync(join(tmpdir(), "magenta-hcp-vitest-"));

	process.env.HOME = testHome;
	process.env[AGENT_DIR_ENV] = join(testHome, ".magenta", "agent");
	process.env[WORKFLOW_STATE_ROOT_ENV] = join(testHome, ".magenta", "tmp", "workflows");

	return () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		if (previousWorkflowRoot === undefined) delete process.env[WORKFLOW_STATE_ROOT_ENV];
		else process.env[WORKFLOW_STATE_ROOT_ENV] = previousWorkflowRoot;
		rmSync(testHome, { recursive: true, force: true });
	};
}
