/**
 * Preset workflows: the six fixed patterns reimplemented as composable library
 * functions on top of WorkflowContext primitives. These demonstrate that the
 * fixed skeletons are not engine magic — they are compositions of the same
 * primitives a user script has access to. Use them in scripts for common cases;
 * the deterministic skeletons in orchestrator.ts remain for direct orchestrate()
 * calls (they carry schema-override soul-steps and are runner-injectable for
 * skeleton tests).
 *
 * Key difference from the engine skeletons:
 * - Engine: receives `runner` + `signal`, uses `runner.spawn` with schema overrides.
 * - Presets: receives `WorkflowContext`, uses `ctx.agent` (schema is opt-in per call).
 *
 * A preset can pass a schema through `ctx.agent(..., { schema })` to constrain a
 * worker's structured output, then read `result.structured`. That keeps the
 * soul-step guards AND the deterministic reads, proving the compositional claim
 * without duplicating the engine.
 */

import type { WorkerResult, WorkflowContext } from "./contract.ts";

/** Numeric-score schema for evaluator/verifier reads (mirrors the engine's). */
const SCORE_SCHEMA = {
	type: "object",
	properties: { score: { type: "number" }, reason: { type: "string" } },
	required: ["score"],
} as const;

/** Boolean-verdict schema for verifier reads (mirrors the engine's). */
const VERDICT_SCHEMA = {
	type: "object",
	properties: { verdict: { type: "boolean" }, reason: { type: "string" } },
	required: ["verdict"],
} as const;

/** Winner-index schema for pairwise judge reads (mirrors the engine's). */
const WINNER_SCHEMA = {
	type: "object",
	properties: { winner: { type: "number", enum: [0, 1] }, reason: { type: "string" } },
	required: ["winner"],
} as const;

/** Read a numeric field from a worker's structured output. */
function readNumber(result: WorkerResult, field: string): number | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "number" && Number.isFinite(s[field])) return s[field] as number;
	return undefined;
}

/** Read a boolean field from a worker's structured output. */
function readBoolean(result: WorkerResult, field: string): boolean | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "boolean") return s[field] as boolean;
	return undefined;
}

/**
 * Preset: Classify then act.
 *
 * Classify the input into one of the handler labels (soul step), then route to
 * exactly the matching handler, or a fallback. Returns the handler's result, or
 * the classifier's result when nothing matched and no fallback was given.
 */
export async function classifyAndAct(
	ctx: WorkflowContext,
	input: string,
	classifier: { task: string },
	handlers: Record<string, { task: string }>,
	fallback?: { task: string },
): Promise<WorkerResult> {
	const labels = Object.keys(handlers);
	const classified = await ctx.agent(
		`${classifier.task}\n\nAvailable labels: ${labels.join(", ")}\n\nInput:\n${input}`,
		{
			label: "classifier",
			guard: ctx.guards.classifier,
			schema: { type: "object", properties: { label: { type: "string", enum: labels } }, required: ["label"] },
		},
	);

	const rawLabel = (classified.structured as { label?: string } | undefined)?.label ?? classified.text.trim();
	const label = labels.find((l) => rawLabel === l || rawLabel.includes(l));
	const handler = label ? handlers[label] : fallback;
	if (!handler) return classified;

	return ctx.agent(`${handler.task}\n\nInput:\n${input}`, { label: "handler" });
}

/**
 * Preset: Fan-out + synthesize.
 *
 * Run all workers in parallel, then feed every result into a synthesizer that
 * merges them into one consolidated artifact.
 */
export async function fanOutSynthesize(
	ctx: WorkflowContext,
	workers: Array<{ task: string; label?: string }>,
	synthesizer: { task: string; label?: string },
	maxConcurrent?: number,
): Promise<WorkerResult> {
	const results = await ctx.parallelAgents(
		workers.map((w, i) => () => ctx.agent(w.task, { label: w.label || `fanout-${i}` })),
		maxConcurrent,
	);

	const merged = results
		.map((r, i) => `--- Worker ${i + 1} (${r.success ? "ok" : "failed"}) ---\n${r.text || r.error || ""}`)
		.join("\n\n");

	return ctx.agent(`${synthesizer.task}\n\n${merged}`, {
		label: synthesizer.label || "synthesizer",
		guard: ctx.guards.synthesizer,
	});
}

/**
 * Preset: Adversarial verify.
 *
 * Generator produces a candidate; N independent verifiers re-check it in
 * parallel, each returning a boolean verdict. Confidence = passed / N.
 * Confirmed when confidence >= threshold. Confidence is computed here, never
 * self-reported by a model.
 */
export async function adversarialVerify(
	ctx: WorkflowContext,
	generator: { task: string },
	verifier: { task: string },
	verifyCount = 3,
	threshold = 0.67,
): Promise<{ generated: string; votes: number; passed: number; confidence: number; confirmed: boolean }> {
	const generated = await ctx.agent(generator.task, { label: "generator" });
	if (!generated.success) {
		return { generated: generated.text, votes: 0, passed: 0, confidence: 0, confirmed: false };
	}

	const votes = await ctx.parallelAgents(
		Array.from({ length: verifyCount }, (_, i) => () =>
			ctx.agent(`${verifier.task}\n\nCandidate to verify:\n${generated.text}`, {
				label: `verifier-${i}`,
				guard: ctx.guards.verifier,
				schema: VERDICT_SCHEMA,
			}),
		),
		verifyCount,
	);

	const passed = votes.filter((v) => readBoolean(v, "verdict") === true).length;
	const confidence = passed / verifyCount;
	return { generated: generated.text, votes: verifyCount, passed, confidence, confirmed: confidence >= threshold };
}

/**
 * Preset: Generate and filter.
 *
 * Generate `candidateCount` candidates in parallel, score each by stated
 * criteria (evaluator returns a number), rank, keep top K.
 */
export async function generateAndFilter(
	ctx: WorkflowContext,
	generator: { task: string },
	evaluator: { task: string },
	candidateCount = 5,
	topK = 3,
): Promise<Array<{ candidate: string; score: number; evaluation: string }>> {
	const candidates = await ctx.parallelAgents(
		Array.from({ length: candidateCount }, (_, i) => () => ctx.agent(generator.task, { label: `gen-${i}` })),
		candidateCount,
	);

	const scored = await ctx.parallelAgents(
		candidates.map((c, i) => () =>
			ctx.agent(`${evaluator.task}\n\nCandidate to score:\n${c.text}`, {
				label: `eval-${i}`,
				guard: ctx.guards.evaluator,
				schema: SCORE_SCHEMA,
			}),
		),
		candidateCount,
	);

	const withScores = candidates.map((c, i) => ({
		candidate: c.text,
		score: readNumber(scored[i], "score") ?? Number.NEGATIVE_INFINITY,
		evaluation: scored[i].text,
	}));
	withScores.sort((a, b) => b.score - a.score);
	return withScores.slice(0, Math.max(1, topK));
}

/**
 * Preset: Tournament.
 *
 * Candidates compete in pairwise elimination rounds judged by a subagent. N
 * candidates -> N-1 comparisons; byes carry over on odd counts. Returns the
 * surviving candidate's text.
 */
export async function tournament(
	ctx: WorkflowContext,
	approaches: Array<{ task: string; label?: string }>,
	judge: { task: string },
): Promise<string> {
	const generated = await ctx.parallelAgents(
		approaches.map((a, i) => () => ctx.agent(a.task, { label: a.label || `appr-${i}` })),
		approaches.length,
	);

	let round = generated.map((r) => r.text);
	let matchNo = 0;
	while (round.length > 1) {
		const next: string[] = [];
		for (let i = 0; i < round.length; i += 2) {
			const a = round[i];
			const b = round[i + 1];
			if (b === undefined) {
				next.push(a); // bye
				continue;
			}
			const verdict = await ctx.agent(`${judge.task}\n\nCandidate 0:\n${a}\n\nCandidate 1:\n${b}`, {
				label: `judge-${matchNo++}`,
				guard: ctx.guards.judge,
				schema: WINNER_SCHEMA,
			});
			next.push(readNumber(verdict, "winner") === 1 ? b : a);
		}
		round = next;
	}
	return round[0] ?? "";
}

/**
 * Preset: Loop until done.
 *
 * Iterate a refine step, feeding prior findings back and excluding them each
 * round. Stop when a round yields no new finding, or the hard cap is hit. The
 * loop owns termination; a model never declares itself done.
 */
export async function loopUntilDone(
	ctx: WorkflowContext,
	initial: string,
	refine: { task: string },
	maxIterations = 10,
): Promise<{ findings: string[]; iterations: number; terminatedBy: "completed" | "max_iterations" }> {
	const findings: string[] = [];
	let iterations = 0;
	let terminatedBy: "completed" | "max_iterations" = "max_iterations";

	while (iterations < maxIterations) {
		iterations += 1;
		const prior = findings.length
			? `\n\nAlready-found (exclude these):\n${findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
			: "";
		const result = await ctx.agent(`${refine.task}\n\nStarting content:\n${initial}${prior}`, {
			label: `refine-${iterations}`,
			guard: ctx.guards.refine,
		});

		const finding = result.text.trim();
		if (!result.success || finding.length === 0) {
			terminatedBy = "completed";
			break;
		}
		findings.push(finding);
	}

	return { findings, iterations, terminatedBy };
}
