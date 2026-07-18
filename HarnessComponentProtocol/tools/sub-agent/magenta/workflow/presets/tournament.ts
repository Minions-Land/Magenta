/**
 * Preset workflow: Tournament (pairwise elimination bracket).
 *
 * Candidates compete in pairwise matches judged by a subagent. N candidates →
 * N-1 comparisons; byes carry over on odd counts. Returns the surviving
 * candidate.
 *
 * Principle demonstrated: score the subjective. When "best" is hard to quantify
 * absolutely, a judge comparing two candidates head-to-head is far more
 * reliable than asking for an absolute score — the bracket turns fuzzy taste
 * into a series of concrete either/or decisions.
 */

const WINNER_SCHEMA = {
	type: "object",
	properties: { winner: { type: "number", enum: [0, 1] }, reason: { type: "string" } },
	required: ["winner"],
} as const;

function readNumberField(result: any, field: string): number | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "number" && Number.isFinite(s[field])) return s[field] as number;
	return undefined;
}

export default async function tournament(args: unknown, ctx: any) {
	const req = args as {
		approaches: Array<{ task: string }>;
		judge: { task: string };
		maxConcurrent?: number;
	};

	// Generate all approaches in parallel.
	const approaches = await ctx.parallelAgents(
		req.approaches.map((slot: any, i: number) => () => ctx.agent(slot.task, { ...slot, label: `appr-${i}` })),
		req.maxConcurrent,
	);

	// Elimination bracket: pairwise matches, winner advances, until one remains.
	// N candidates -> exactly N-1 comparisons. Byes carry over on odd counts.
	let matchNo = 0;
	let round = approaches.slice();
	while (round.length > 1) {
		const nextRound: any[] = [];
		for (let i = 0; i < round.length; i += 2) {
			const a = round[i];
			const b = round[i + 1];
			if (!b) {
				nextRound.push(a); // bye
				continue;
			}
			const verdict = await ctx.agent(`${req.judge.task}\n\nCandidate 0:\n${a.text}\n\nCandidate 1:\n${b.text}`, {
				...req.judge,
				label: `judge-${matchNo++}`,
				guard: ctx.guards.judge,
				schema: WINNER_SCHEMA,
			});
			const winnerIdx = readNumberField(verdict, "winner");
			nextRound.push(winnerIdx === 1 ? b : a);
		}
		round = nextRound;
	}

	return { outcome: round[0], terminatedBy: "completed" };
}
