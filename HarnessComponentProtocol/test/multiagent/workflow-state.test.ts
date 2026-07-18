import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MultiAgentOrchestrator, type WorkerRunner } from "../../tools/sub-agent/magenta/workflow/orchestrator.ts";
import type { SpawnWorkerOptions } from "../../tools/sub-agent/magenta/workflow/worker.ts";
import type { WorkerResult } from "../../tools/sub-agent/magenta/workflow-types.ts";

/**
 * Phase 3 state-persistence tests. A script workflow must leave an inspectable
 * trail under `<cwd>/.magenta/tmp/<workflow-id>/` — log.jsonl for the event
 * stream, nodes/<label>/output.json per agent, result.json for the return
 * value — so a run can be observed and survives a crash. We run with a fake
 * runner in a throwaway cwd and assert the files land.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "fixtures", "sample-workflow.ts");

function fakeRunner(): WorkerRunner {
	const run = async (opts: SpawnWorkerOptions): Promise<WorkerResult> => ({
		workerId: opts.workerId,
		text: `ran:${opts.workerId}`,
		durationMs: 1,
		success: true,
	});
	return { spawn: (o) => run(o), parallel: async (specs) => Promise.all(specs.map(run)) };
}

let tmpCwd: string;

beforeEach(() => {
	tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-test-"));
});

afterEach(() => {
	try {
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe("workflow state persistence", () => {
	it("writes log.jsonl, per-node outputs, and result.json under .magenta/tmp/<id>", async () => {
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner: fakeRunner() });
		const result = await orch.orchestrate({
			pattern: "script",
			scriptPath: SAMPLE,
			args: { topic: "persistence" },
		});

		const workflowId = result.outcome?.workerId as string;
		expect(workflowId).toMatch(/^wf-/);

		const stateDir = path.join(tmpCwd, ".magenta", "tmp", workflowId);
		expect(fs.existsSync(stateDir)).toBe(true);

		// log.jsonl exists and contains a phase event and agent events.
		const logPath = path.join(stateDir, "log.jsonl");
		expect(fs.existsSync(logPath)).toBe(true);
		const logLines = fs
			.readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(logLines.some((e) => e.type === "phase" && e.name === "Work")).toBe(true);
		expect(logLines.filter((e) => e.type === "agent")).toHaveLength(4); // lead + 3 subs

		// Per-node output for the lead worker.
		const leadOut = path.join(stateDir, "nodes", "lead", "output.json");
		expect(fs.existsSync(leadOut)).toBe(true);
		const lead = JSON.parse(fs.readFileSync(leadOut, "utf8")) as WorkerResult;
		expect(lead.workerId).toBe("lead");

		// result.json holds the script's return value.
		const resultPath = path.join(stateDir, "result.json");
		expect(fs.existsSync(resultPath)).toBe(true);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { topic: string; batchCount: number };
		expect(payload.topic).toBe("persistence");
		expect(payload.batchCount).toBe(3);
	});

	it("writes error.json when the workflow module cannot be loaded", async () => {
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner: fakeRunner() });
		const result = await orch.orchestrate({
			pattern: "script",
			scriptPath: path.join(here, "fixtures", "nonexistent-workflow.ts"),
			args: {},
		});

		expect(result.outcome?.success).toBe(false);
		const workflowId = result.outcome?.workerId as string;
		const errorPath = path.join(tmpCwd, ".magenta", "tmp", workflowId, "error.json");
		expect(fs.existsSync(errorPath)).toBe(true);
		const err = JSON.parse(fs.readFileSync(errorPath, "utf8")) as { error: string };
		expect(err.error).toBeTruthy();
	});
});
