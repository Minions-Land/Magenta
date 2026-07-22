import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOG_MAX_BYTES } from "../../_magenta/log-retention.ts";
import {
	cleanupWorkflowArtifacts,
	MultiAgentOrchestrator,
	type WorkerRunner,
} from "../../tools/sub-agent/magenta/workflow/orchestrator.ts";
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
		const orch = new MultiAgentOrchestrator({
			cwd: tmpCwd,
			runner: fakeRunner(),
			stateRoot: path.join(tmpCwd, ".magenta", "tmp"),
		});
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
		const orch = new MultiAgentOrchestrator({
			cwd: tmpCwd,
			runner: fakeRunner(),
			stateRoot: path.join(tmpCwd, ".magenta", "tmp"),
		});
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

	it("reclaims completed same-process runs but preserves incomplete and unknown artifacts", async () => {
		const stateRoot = path.join(tmpCwd, ".magenta", "tmp");
		const completed = path.join(stateRoot, `wf-${process.pid}-1-completed`);
		const withUnknown = path.join(stateRoot, "wf-999999-1-unknown");
		const incomplete = path.join(stateRoot, `wf-${process.pid}-1-running`);
		const knownFiles = [
			path.join(completed, "log.jsonl"),
			path.join(completed, "result.json"),
			path.join(completed, "nodes", "worker", "output.json"),
			path.join(withUnknown, "log.jsonl"),
			path.join(withUnknown, "result.json"),
		];
		for (const file of knownFiles) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "{}\n");
			fs.utimesSync(file, new Date(0), new Date(0));
		}
		const unknown = path.join(withUnknown, "keep.bin");
		fs.writeFileSync(unknown, "keep");
		const incompleteLog = path.join(incomplete, "log.jsonl");
		fs.mkdirSync(incomplete, { recursive: true });
		fs.writeFileSync(incompleteLog, "running\n");
		fs.utimesSync(incompleteLog, new Date(0), new Date(0));

		await cleanupWorkflowArtifacts(stateRoot, { maxAgeMs: 1, now: Date.now() });

		expect(fs.existsSync(completed)).toBe(false);
		expect(fs.readFileSync(unknown, "utf8")).toBe("keep");
		expect(fs.existsSync(path.join(withUnknown, "result.json"))).toBe(false);
		expect(fs.readFileSync(incompleteLog, "utf8")).toBe("running\n");
	});

	it("keeps oversized node and result artifacts bounded and valid JSON", async () => {
		const huge = "x".repeat(DEFAULT_LOG_MAX_BYTES + 1024);
		const runner: WorkerRunner = {
			spawn: async (options) => ({
				workerId: options.workerId,
				text: huge,
				durationMs: 1,
				success: true,
			}),
			parallel: async () => [],
		};
		const source = "export default async (_args, ctx) => ctx.agent('oversized', { label: 'oversized' });";
		const scriptPath = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
		const stateRoot = path.join(tmpCwd, ".magenta", "tmp");
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner, stateRoot });
		const result = await orch.orchestrate({ pattern: "script", scriptPath, args: {} });
		const workflowId = result.outcome?.workerId as string;
		const nodePath = path.join(stateRoot, workflowId, "nodes", "oversized", "output.json");
		const resultPath = path.join(stateRoot, workflowId, "result.json");

		for (const artifact of [nodePath, resultPath]) {
			expect(fs.statSync(artifact).size).toBeLessThanOrEqual(DEFAULT_LOG_MAX_BYTES);
			expect(JSON.parse(fs.readFileSync(artifact, "utf8"))).toMatchObject({ truncated: true });
		}
	});
});
