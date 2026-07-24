/**
 * Preset workflow: Generate and filter.
 *
 * Generate `count` independent candidates in parallel, score each by explicit
 * criteria (evaluator returns a number), rank, keep top-K.
 *
 * Principle demonstrated: separate the roles. The generator never scores its
 * own work — an independent evaluator assigns each candidate a number against
 * fixed criteria, so the ranking is earned, not self-declared.
 */

const SCORE_SCHEMA = {
	type: "object",
	properties: { score: { type: "number" }, reason: { type: "string" } },
	required: ["score"],
} as const;

function readNumberField(result: any, field: string): number | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "number" && Number.isFinite(s[field])) return s[field] as number;
	return undefined;
}

export default async function generateAndFilter(args: unknown, ctx: any) {
	const req = args as {
		generator: { task: string };
		evaluator: { task: string };
		count: number;
		keepTop?: number;
		maxConcurrent?: number;
	};

	const count = Math.max(1, req.count);

	// Generate `count` independent candidates in parallel.
	const candidates = await ctx.parallelAgents(
		Array.from(
			{ length: count },
			(_, i) => () => ctx.agent(req.generator.task, { ...req.generator, label: `gen-${i}` }),
		),
		req.maxConcurrent,
	);
	const successfulCandidates = candidates.filter((candidate: any) => candidate.success);
	if (successfulCandidates.length === 0) {
		return { outcome: candidates[0], terminatedBy: "budget" };
	}

	// Score each candidate by explicit criteria (evaluator returns a number).
	const evaluations = await ctx.parallelAgents(
		successfulCandidates.map(
			(c: any, i: number) => () =>
				ctx.agent(`${req.evaluator.task}\n\nCandidate to score:\n${c.text}`, {
					...req.evaluator,
					label: `eval-${i}`,
					guard: ctx.guards.evaluator,
					schema: SCORE_SCHEMA,
				}),
		),
		req.maxConcurrent,
	);

	// Rank by score, keep top-K. Ranking is deterministic in the skeleton.
	const ranked = successfulCandidates
		.flatMap((candidate: any, i: number) => {
			const evaluation = evaluations[i];
			const score = evaluation?.success ? readNumberField(evaluation, "score") : undefined;
			return score === undefined ? [] : [{ candidate, score }];
		})
		.sort((a: any, b: any) => b.score - a.score);
	if (ranked.length === 0) {
		const evaluation = evaluations[0];
		return {
			outcome: evaluation?.success
				? { ...evaluation, success: false, error: "no evaluator returned a valid score" }
				: evaluation,
			terminatedBy: "budget",
		};
	}
	const keepTop = Math.max(1, req.keepTop ?? 1);
	const finalists = ranked.slice(0, keepTop).map((r: any) => r.candidate);
	const winner = finalists[0];

	return {
		outcome: winner,
		...(finalists.length > 1 ? { finalists } : {}),
		terminatedBy: "completed",
	};
}
