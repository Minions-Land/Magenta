/**
 * Reusable snippet: Four-axis scoring (best-practice REFLECT pattern).
 *
 * Score work on four standard axes, each 0–1 with a justification. This turns
 * "is it good?" (unanswerable) into four concrete questions. Use this in the
 * REFLECT phase of a research loop to grade the IMPLEMENT output.
 *
 * The four axes:
 * - Correctness: does it do the right thing?
 * - Coverage: how much of the contract / requirements are satisfied?
 * - Rigor: reproducible? Provenance clear? Evidence traceable?
 * - Format compliance: does the output match the requested schema / shape?
 *
 * Usage:
 *   1. Copy this snippet into your workflow script.
 *   2. Call `fourAxisScore(ctx, artifact, contract)` in your REFLECT phase.
 *   3. Use the returned scores to decide: iterate, finalize, or restart.
 */

export type FourAxisScores = {
	correctness: { score: number; reason: string };
	coverage: { score: number; reason: string };
	rigor: { score: number; reason: string };
	format: { score: number; reason: string };
	total: number;
};

const FOUR_AXIS_SCHEMA = {
	type: "object",
	properties: {
		correctness: { type: "object", properties: { score: { type: "number" }, reason: { type: "string" } } },
		coverage: { type: "object", properties: { score: { type: "number" }, reason: { type: "string" } } },
		rigor: { type: "object", properties: { score: { type: "number" }, reason: { type: "string" } } },
		format: { type: "object", properties: { score: { type: "number" }, reason: { type: "string" } } },
	},
	required: ["correctness", "coverage", "rigor", "format"],
} as const;

export async function fourAxisScore(ctx: any, artifact: string, contract: string[]): Promise<FourAxisScores> {
	const prompt =
		`You are the Evaluator. Grade the following artifact against the contract.\n\n` +
		`**Contract (testable assertions):**\n${contract.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n` +
		`**Artifact:**\n${artifact}\n\n` +
		`Score on four axes, each 0–1 with a one-line justification:\n` +
		`- **correctness**: does it do the right thing?\n` +
		`- **coverage**: how much of the contract is satisfied?\n` +
		`- **rigor**: reproducible, provenance clear, evidence traceable?\n` +
		`- **format**: does the output match the requested schema/shape?\n\n` +
		`Be strict: 0.5 means half-done, not "pretty good".`;

	const result = await ctx.agent(prompt, {
		label: "four-axis-score",
		schema: FOUR_AXIS_SCHEMA,
		guard: ctx.guards.evaluator,
	});

	const scores = result.structured as FourAxisScores;
	if (!scores) throw new Error("Evaluator returned no scores");

	const total = (scores.correctness.score + scores.coverage.score + scores.rigor.score + scores.format.score) / 4;

	ctx.log(
		`Four-axis scores: correctness=${scores.correctness.score}, coverage=${scores.coverage.score}, rigor=${scores.rigor.score}, format=${scores.format.score}, total=${total.toFixed(2)}`,
	);

	return { ...scores, total };
}
