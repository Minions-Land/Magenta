import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerResult } from "../../multiagent/HcpServer.ts";
import { MultiAgentOrchestrator, type WorkerRunner } from "../../multiagent/workflow/magenta/orchestrator.ts";
import type { SpawnWorkerOptions } from "../../multiagent/workflow/magenta/worker.ts";

/**
 * Script-pattern tests. A workflow authored as an executable module runs its
 * own control flow using the injected primitives; the runtime routes every
 * spawn through the orchestrator's runner. We drive it with a FAKE runner so no
 * pi process launches — proving the script's agent()/parallelAgents() calls go
 * through the same safe channel as the fixed skeletons.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "fixtures", "sample-workflow.ts");

// A throwaway cwd so workflow state (.magenta/tmp) never pollutes the repo.
let tmpCwd: string;
beforeEach(() => {
	tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-script-test-"));
});
afterEach(() => {
	try {
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function makeRunner(respond: (opts: SpawnWorkerOptions) => Partial<WorkerResult>): {
	runner: WorkerRunner;
	calls: SpawnWorkerOptions[];
} {
	const calls: SpawnWorkerOptions[] = [];
	const run = async (opts: SpawnWorkerOptions): Promise<WorkerResult> => {
		calls.push(opts);
		const r = respond(opts);
		return {
			workerId: opts.workerId,
			text: r.text ?? `ran:${opts.workerId}`,
			structured: r.structured,
			durationMs: 1,
			success: r.success ?? true,
		};
	};
	return {
		calls,
		runner: {
			spawn: (opts) => run(opts),
			parallel: async (specs) => Promise.all(specs.map((s) => run(s))),
		},
	};
}

describe("script workflow pattern", () => {
	it("runs a workflow module and wraps its return value as the outcome", async () => {
		const { runner, calls } = makeRunner((opts) => ({ text: `did ${opts.workerId}` }));
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner });

		const result = await orch.orchestrate({
			pattern: "script",
			scriptPath: SAMPLE,
			args: { topic: "reproducibility" },
		});

		expect(result.pattern).toBe("script");
		expect(result.terminatedBy).toBe("completed");
		expect(result.outcome?.success).toBe(true);

		// The script returned an object; it lands in outcome.structured.
		const payload = result.outcome?.structured as {
			topic: string;
			batchCount: number;
			batchTexts: string[];
		};
		expect(payload.topic).toBe("reproducibility");
		expect(payload.batchCount).toBe(3);
		expect(payload.batchTexts).toHaveLength(3);

		// 1 lead + 3 batch = 4 spawns recorded, all through the fake runner.
		expect(calls).toHaveLength(4);
		expect(calls.map((c) => c.workerId)).toEqual(["lead", "sub-0", "sub-1", "sub-2"]);
	});

	it("routes the guard into the lead worker's system prompt", async () => {
		const { runner, calls } = makeRunner(() => ({}));
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner });
		await orch.orchestrate({ pattern: "script", scriptPath: SAMPLE, args: { topic: "x" } });

		const lead = calls.find((c) => c.workerId === "lead");
		expect(lead?.systemPrompt).toBeTruthy();
		// The synthesizer guard text should be present (soul step injected).
		expect(lead?.systemPrompt).toContain("consolidated artifact");
	});

	it("lists every spawned worker in the result", async () => {
		const { runner } = makeRunner(() => ({}));
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner });
		const result = await orch.orchestrate({ pattern: "script", scriptPath: SAMPLE, args: { topic: "y" } });

		// 4 spawned workers + 1 outcome node.
		expect(result.workers).toHaveLength(5);
	});

	it("surfaces a script error as a failed outcome instead of throwing", async () => {
		const { runner } = makeRunner(() => ({}));
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner });
		const result = await orch.orchestrate({
			pattern: "script",
			scriptPath: path.join(here, "fixtures", "does-not-exist.ts"),
			args: {},
		});
		expect(result.outcome?.success).toBe(false);
		expect(result.terminatedBy).toBe("budget");
	});

	it("runs an inline script supplied as a data: URL (the sub_agent inline path)", async () => {
		const { runner, calls } = makeRunner((opts) => ({ text: `did ${opts.workerId}` }));
		const orch = new MultiAgentOrchestrator({ cwd: tmpCwd, runner });

		// Mirrors how the sub_agent tool encodes an inline `script` string: plain
		// JavaScript ES module, base64 in a data: URL used as scriptPath.
		const source = [
			"export default async (args, ctx) => {",
			"  const lead = await ctx.agent('lead task', { label: 'lead' });",
			"  const subs = await ctx.parallelAgents([",
			"    () => ctx.agent('a', { label: 'sub-0' }),",
			"    () => ctx.agent('b', { label: 'sub-1' }),",
			"  ]);",
			"  return { lead: lead.text, subCount: subs.length, topic: args.topic };",
			"};",
		].join("\n");
		const scriptPath = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;

		const result = await orch.orchestrate({
			pattern: "script",
			scriptPath,
			args: { topic: "inline" },
		});

		expect(result.pattern).toBe("script");
		expect(result.terminatedBy).toBe("completed");
		expect(result.outcome?.success).toBe(true);
		const payload = result.outcome?.structured as { subCount: number; topic: string };
		expect(payload.subCount).toBe(2);
		expect(payload.topic).toBe("inline");
		// Every spawn still flowed through the injected runner (safety boundary held).
		expect(calls.map((c) => c.workerId)).toEqual(["lead", "sub-0", "sub-1"]);
	});
});
