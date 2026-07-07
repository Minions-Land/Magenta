import { describe, expect, it } from "vitest";
import type { WorkerResult, WorkflowContext } from "../../modules/multiagent/contract.ts";
import * as presets from "../../modules/multiagent/presets.ts";
import type { SpawnWorkerOptions } from "../../modules/multiagent/workflow/magenta/worker.ts";

/**
 * Preset library equivalence tests. Each preset is a composition of the
 * WorkflowContext primitives; these tests exercise their control flow with a
 * fake context (no pi spawn) and assert they reproduce the same ordering,
 * routing, and termination as the engine skeletons — proving the compositional
 * claim without duplicating all 12 skeleton tests.
 */

interface ScriptedResponse {
	text?: string;
	structured?: unknown;
	success?: boolean;
}

function makeFakeContext(respond: (opts: SpawnWorkerOptions) => ScriptedResponse): {
	ctx: WorkflowContext;
	calls: SpawnWorkerOptions[];
} {
	const calls: SpawnWorkerOptions[] = [];
	let counter = 0;

	const agent: WorkflowContext["agent"] = async (prompt, options) => {
		const opts: SpawnWorkerOptions = {
			workerId: options?.label || `agent-${counter++}`,
			prompt,
			systemPrompt: options?.guard,
			schema: options?.schema,
			cwd: "/fake",
		};
		calls.push(opts);
		const r = respond(opts);
		return {
			workerId: opts.workerId,
			text: r.text ?? "",
			structured: r.structured,
			durationMs: 1,
			success: r.success ?? true,
		};
	};

	const parallelAgents: WorkflowContext["parallelAgents"] = async (tasks) => {
		const results = [];
		for (const task of tasks) {
			results.push(await task());
		}
		return results;
	};

	const ctx: WorkflowContext = {
		agent,
		parallelAgents,
		pipeline: async () => [],
		phase: () => {},
		log: () => {},
		guards: {
			classifier: "CLASSIFY FIRST.",
			synthesizer: "MERGE ALL.",
			verifier: "RE-CHECK.",
			evaluator: "SCORE IT.",
			judge: "COMPARE TWO.",
			refine: "FIND NEW.",
		} as Record<string, string>,
		workflowId: "test",
		cwd: "/fake",
	};

	return { ctx, calls };
}

describe("classifyAndAct preset", () => {
	it("classifies first, then routes to the matching handler", async () => {
		const { ctx, calls } = makeFakeContext((opts) => {
			if (opts.workerId === "classifier") return { structured: { label: "bug" } };
			return { text: "handled" };
		});
		const result = await presets.classifyAndAct(
			ctx,
			"app crashes",
			{ task: "classify this" },
			{ bug: { task: "fix bug" }, feature: { task: "implement" } },
		);
		expect(calls).toHaveLength(2); // classifier + handler
		expect(calls[0].workerId).toBe("classifier");
		expect(calls[1].workerId).toBe("handler");
		expect(calls[1].prompt).toContain("fix bug");
		expect(result.text).toBe("handled");
	});

	it("uses the fallback when no label matches", async () => {
		const { ctx, calls } = makeFakeContext(() => ({ structured: { label: "nope" } }));
		await presets.classifyAndAct(
			ctx,
			"x",
			{ task: "classify" },
			{ bug: { task: "fix" } },
			{ task: "fallback handler" },
		);
		expect(calls).toHaveLength(2);
		expect(calls[1].prompt).toContain("fallback handler");
	});
});

describe("fanOutSynthesize preset", () => {
	it("runs all workers then feeds every result into the synthesizer", async () => {
		const { ctx, calls } = makeFakeContext((opts) => ({ text: `result-${opts.workerId}` }));
		await presets.fanOutSynthesize(ctx, [{ task: "w1" }, { task: "w2" }], { task: "merge" });
		expect(calls).toHaveLength(3); // 2 workers + 1 synthesizer
		const synth = calls[2];
		expect(synth.prompt).toContain("result-fanout-0");
		expect(synth.prompt).toContain("result-fanout-1");
		expect(synth.systemPrompt).toContain("MERGE ALL");
	});
});

describe("adversarialVerify preset", () => {
	it("computes confidence as passed / verifyCount", async () => {
		const { ctx } = makeFakeContext((opts) => {
			if (opts.workerId === "generator") return { text: "candidate" };
			// 2 of 3 verifiers pass.
			if (opts.workerId === "verifier-0") return { structured: { verdict: true } };
			if (opts.workerId === "verifier-1") return { structured: { verdict: true } };
			return { structured: { verdict: false } };
		});
		const result = await presets.adversarialVerify(ctx, { task: "generate" }, { task: "verify" }, 3, 0.6);
		expect(result.votes).toBe(3);
		expect(result.passed).toBe(2);
		expect(result.confidence).toBeCloseTo(0.667, 2);
		expect(result.confirmed).toBe(true); // >= 0.6
	});
});

describe("generateAndFilter preset", () => {
	it("generates N, scores all, ranks, keeps top K", async () => {
		const { ctx, calls } = makeFakeContext((opts) => {
			if (opts.workerId.startsWith("gen")) return { text: `candidate-${opts.workerId}` };
			// Score by extracting the digit from workerId (e.g., eval-2 → score 2).
			const match = opts.workerId.match(/\d+/);
			const score = match ? Number.parseInt(match[0], 10) : 0;
			return { structured: { score }, text: `scored ${score}` };
		});
		const results = await presets.generateAndFilter(ctx, { task: "generate" }, { task: "score" }, 5, 2);
		expect(calls.filter((c) => c.workerId.startsWith("gen"))).toHaveLength(5);
		expect(calls.filter((c) => c.workerId.startsWith("eval"))).toHaveLength(5);
		expect(results).toHaveLength(2);
		// Top 2: eval-4 (score 4) and eval-3 (score 3).
		expect(results[0].score).toBe(4);
		expect(results[1].score).toBe(3);
	});
});

describe("tournament preset", () => {
	it("runs pairwise elimination until one winner remains", async () => {
		const { ctx, calls } = makeFakeContext((opts) => {
			if (opts.workerId.startsWith("appr")) return { text: `approach-${opts.workerId}` };
			// Judge always picks candidate 0 (winner: 0).
			return { structured: { winner: 0 } };
		});
		const winner = await presets.tournament(
			ctx,
			[{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }],
			{ task: "compare" },
		);
		expect(calls.filter((c) => c.workerId.startsWith("appr"))).toHaveLength(4);
		// 4 candidates -> 2 round-1 matches, 1 round-2 match = 3 judge calls.
		expect(calls.filter((c) => c.workerId.startsWith("judge"))).toHaveLength(3);
		expect(winner).toContain("approach-appr-0"); // winner of the bracket
	});
});

describe("loopUntilDone preset", () => {
	it("stops when a round yields no new finding", async () => {
		const rounds = ["finding-1", "finding-2", ""]; // empty = stop
		const { ctx, calls } = makeFakeContext(() => {
			const idx = calls.length - 1; // respond runs after push; make it 0-based
			return { text: rounds[idx] || "" };
		});
		const result = await presets.loopUntilDone(ctx, "start", { task: "refine" });
		expect(calls).toHaveLength(3); // 3 calls: f1, f2, empty
		expect(result.findings).toEqual(["finding-1", "finding-2"]);
		expect(result.terminatedBy).toBe("completed");
	});

	it("feeds prior findings back each round", async () => {
		const { ctx, calls } = makeFakeContext(() => {
			const idx = calls.length - 1;
			return { text: `f-${idx}` };
		});
		await presets.loopUntilDone(ctx, "start", { task: "find more" }, 2);
		// Second round's prompt must include the first finding.
		expect(calls[1].prompt).toContain("f-0");
	});

	it("respects the hard iteration cap", async () => {
		const { ctx, calls } = makeFakeContext((_opts, idx = calls.length) => ({ text: `finding-${idx}` }));
		const result = await presets.loopUntilDone(ctx, "start", { task: "find more" }, 4);
		expect(calls).toHaveLength(4);
		expect(result.terminatedBy).toBe("max_iterations");
	});
});
