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
		Array.from({ length: count }, (_, i) => () => ctx.agent(req.generator.task, { label: `gen-${i}` })),
		req.maxConcurrent,
	);

	// Score each candidate by explicit criteria (evaluator returns a number).
	const evaluations = await ctx.parallelAgents(
		candidates.map((c: any, i: number) => () =>
			ctx.agent(`${req.evaluator.task}\n\nCandidate to score:\n${c.text}`, {
				label: `eval-${i}`,
				guard: ctx.guards.evaluator,
				schema: SCORE_SCHEMA,
			}),
		),
		req.maxConcurrent,
	);

	// Rank by score, keep top-K. Ranking is deterministic in the skeleton.
	const ranked = candidates
		.map((candidate: any, i: number) => ({ candidate, score: readNumberField(evaluations[i], "score") ?? -Infinity }))
		.sort((a: any, b: any) => b.score - a.score);
	const keepTop = Math.max(1, req.keepTop ?? 1);
	const finalists = ranked.slice(0, keepTop).map((r: any) => r.candidate);
	const winner = finalists[0];

	return {
		outcome: winner,
		...(finalists.length > 1 ? { finalists } : {}),
		terminatedBy: "completed",
	};
}
