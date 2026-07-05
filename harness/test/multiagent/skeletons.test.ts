import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../../modules/multiagent/contract.ts";
import {
	MultiAgentOrchestrator,
	type WorkerRunner,
} from "../../modules/multiagent/magenta/orchestrator.ts";
import type { SpawnWorkerOptions } from "../../modules/multiagent/magenta/worker.ts";

/**
 * Deterministic skeleton tests. These exercise the control flow of each pattern
 * with a FAKE runner — no pi processes, no tokens, no risk. This is exactly the
 * safe path that avoids the "spawn real workers to test the flow" trap.
 *
 * The fake runner lets a test script per-worker responses by workerId prefix and
 * records every spawn so we can assert the skeleton's ordering, routing,
 * fan-out, ranking, and termination.
 */

interface ScriptedResponse {
	text?: string;
	structured?: unknown;
	success?: boolean;
}

function makeRunner(
	respond: (opts: SpawnWorkerOptions, callIndex: number) => ScriptedResponse,
): { runner: WorkerRunner; calls: SpawnWorkerOptions[] } {
	const calls: SpawnWorkerOptions[] = [];
	let counter = 0;

	const run = async (opts: SpawnWorkerOptions): Promise<WorkerResult> => {
		const idx = counter++;
		calls.push(opts);
		const r = respond(opts, idx);
		return {
			workerId: opts.workerId,
			text: r.text ?? "",
			structured: r.structured,
			durationMs: 1,
			success: r.success ?? true,
		};
	};

	const runner: WorkerRunner = {
		spawn: (opts) => run(opts),
		parallel: async (specs) => Promise.all(specs.map((s) => run(s))),
	};
	return { runner, calls };
}

describe("classify_and_act skeleton", () => {
	it("classifies first, then routes to exactly the matching handler", async () => {
		const { runner, calls } = makeRunner((opts) => {
			if (opts.workerId.startsWith("classify")) return { structured: { label: "bug" } };
			return { text: `handled by ${opts.workerId}` };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "classify_and_act",
			input: "app crashes on launch",
			classifier: { task: "classify" },
			handlers: {
				bug: { task: "fix the bug" },
				feature: { task: "design the feature" },
			},
		});

		// Exactly two workers ran: the classifier, then ONE handler.
		expect(calls).toHaveLength(2);
		expect(calls[0].workerId).toMatch(/^classify/);
		expect(calls[1].workerId).toMatch(/^handle/);
		// The handler that ran was the "bug" handler (its prompt was routed in).
		expect(calls[1].prompt).toContain("fix the bug");
		expect(result.outcome?.text).toContain("handled by");
		expect(result.terminatedBy).toBe("completed");
	});

	it("falls back when the label matches no handler", async () => {
		const { runner, calls } = makeRunner((opts) => {
			if (opts.workerId.startsWith("classify")) return { structured: { label: "unknown" } };
			return { text: "fallback ran" };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "classify_and_act",
			input: "???",
			classifier: { task: "classify" },
			handlers: { bug: { task: "fix" } },
			fallback: { task: "handle anything" },
		});
		expect(calls[1].prompt).toContain("handle anything");
		expect(result.outcome?.text).toBe("fallback ran");
	});

	it("stops at the classifier when no handler and no fallback match", async () => {
		const { runner, calls } = makeRunner(() => ({ structured: { label: "nope" } }));
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "classify_and_act",
			input: "x",
			classifier: { task: "classify" },
			handlers: { bug: { task: "fix" } },
		});
		expect(calls).toHaveLength(1); // only the classifier ran
		expect(result.terminatedBy).toBe("completed");
	});
});

describe("adversarial_verify skeleton", () => {
	it("computes confidence as passed / verifyCount and accepts above threshold", async () => {
		const { runner, calls } = makeRunner((opts, idx) => {
			if (opts.workerId.startsWith("generate")) return { text: "candidate issue" };
			// 3 verifiers: pass, pass, fail -> 2/3 ~= 0.667
			const verdicts = [true, true, false];
			return { structured: { verdict: verdicts[idx - 1] } };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "adversarial_verify",
			generator: { task: "find issues" },
			verifier: { task: "verify" },
			verifyCount: 3,
			confidenceThreshold: 0.6,
		});
		// 1 generator + 3 verifiers.
		expect(calls).toHaveLength(4);
		expect(result.confidence).toBeCloseTo(2 / 3, 5);
		expect(result.terminatedBy).toBe("completed"); // 0.667 >= 0.6
	});

	it("marks threshold when confidence is below the bar", async () => {
		const { runner } = makeRunner((opts) => {
			if (opts.workerId.startsWith("generate")) return { text: "c" };
			return { structured: { verdict: false } };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "adversarial_verify",
			generator: { task: "g" },
			verifier: { task: "v" },
			verifyCount: 2,
			confidenceThreshold: 0.8,
		});
		expect(result.confidence).toBe(0);
		expect(result.terminatedBy).toBe("threshold");
	});
});

describe("generate_and_filter skeleton", () => {
	it("generates count candidates, scores each, and picks the highest", async () => {
		const scores = [3, 9, 5];
		const { runner, calls } = makeRunner((opts, idx) => {
			if (opts.workerId.startsWith("gen")) return { text: `candidate-${idx}` };
			// evaluators start after the 3 generators (idx 3,4,5)
			return { structured: { score: scores[idx - 3] } };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "generate_and_filter",
			generator: { task: "generate" },
			count: 3,
			evaluator: { task: "score" },
		});
		// 3 generators + 3 evaluators.
		expect(calls).toHaveLength(6);
		// Highest score (9) belongs to the 2nd candidate -> "candidate-1".
		expect(result.outcome?.text).toBe("candidate-1");
		expect(result.terminatedBy).toBe("completed");
	});
});

describe("tournament skeleton", () => {
	it("runs N-1 pairwise matches and returns the surviving candidate", async () => {
		// 4 approaches -> 3 judge matches. Judge always picks index 0 (candidate a).
		const { runner, calls } = makeRunner((opts, idx) => {
			if (opts.workerId.startsWith("appr")) return { text: `approach-${idx}` };
			return { structured: { winner: 0 } };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "tournament",
			approaches: [{ task: "a" }, { task: "b" }, { task: "c" }, { task: "d" }],
			judge: { task: "compare" },
		});
		const judgeCalls = calls.filter((c) => c.workerId.startsWith("judge"));
		expect(judgeCalls).toHaveLength(3); // N-1 comparisons
		// Winner always index 0 -> first approach "approach-0" survives.
		expect(result.outcome?.text).toBe("approach-0");
		expect(result.terminatedBy).toBe("completed");
	});

	it("carries a bye when the field is odd", async () => {
		// 3 approaches: round1 = match(a,b) + bye(c); round2 = match(winner, c). 2 matches.
		const { runner, calls } = makeRunner((opts) => {
			if (opts.workerId.startsWith("appr")) return { text: opts.prompt };
			return { structured: { winner: 1 } }; // always pick the second
		});
		const orch = new MultiAgentOrchestrator({ runner });
		await orch.orchestrate({
			pattern: "tournament",
			approaches: [{ task: "a" }, { task: "b" }, { task: "c" }],
			judge: { task: "compare" },
		});
		const judgeCalls = calls.filter((c) => c.workerId.startsWith("judge"));
		expect(judgeCalls).toHaveLength(2);
	});
});

describe("loop_until_done skeleton", () => {
	it("stops when a round yields no new findings (skeleton owns termination)", async () => {
		const rounds = ["finding A", "finding B", ""]; // 3rd round: empty -> stop
		const { runner, calls } = makeRunner((_opts, idx) => ({ text: rounds[idx] }));
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "loop_until_done",
			initial: "start",
			refine: { task: "find more" },
			maxIterations: 10,
		});
		expect(calls).toHaveLength(3);
		expect(result.iterations).toBe(3);
		expect(result.terminatedBy).toBe("completed");
	});

	it("feeds prior findings back into each round's prompt", async () => {
		const rounds = ["A", "B", ""];
		const { runner, calls } = makeRunner((_opts, idx) => ({ text: rounds[idx] }));
		const orch = new MultiAgentOrchestrator({ runner });
		await orch.orchestrate({
			pattern: "loop_until_done",
			initial: "start",
			refine: { task: "find more" },
		});
		// Second round's prompt must include the first round's finding "A".
		expect(calls[1].prompt).toContain("A");
		// Third round's prompt must include both A and B.
		expect(calls[2].prompt).toContain("A");
		expect(calls[2].prompt).toContain("B");
	});

	it("respects the hard iteration cap", async () => {
		// Never returns empty -> must stop at maxIterations.
		const { runner, calls } = makeRunner((_opts, idx) => ({ text: `finding-${idx}` }));
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "loop_until_done",
			initial: "start",
			refine: { task: "find more" },
			maxIterations: 4,
		});
		expect(calls).toHaveLength(4);
		expect(result.iterations).toBe(4);
		expect(result.terminatedBy).toBe("max_iterations");
	});
});

describe("fan_out_synthesize skeleton", () => {
	it("runs all workers then feeds every result into the synthesizer", async () => {
		const { runner, calls } = makeRunner((opts) => {
			if (opts.workerId.startsWith("synth")) return { text: "merged" };
			return { text: `result-${opts.prompt}` };
		});
		const orch = new MultiAgentOrchestrator({ runner });
		const result = await orch.orchestrate({
			pattern: "fan_out_synthesize",
			workers: [{ task: "w1" }, { task: "w2" }, { task: "w3" }],
			synthesizer: { task: "merge them" },
		});
		expect(calls).toHaveLength(4); // 3 workers + 1 synthesizer
		const synthCall = calls.find((c) => c.workerId.startsWith("synth"));
		// The synthesizer prompt must contain every worker's output.
		expect(synthCall?.prompt).toContain("result-w1");
		expect(synthCall?.prompt).toContain("result-w2");
		expect(synthCall?.prompt).toContain("result-w3");
		expect(result.outcome?.text).toBe("merged");
	});
});
